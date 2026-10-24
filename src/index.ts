import * as core from '@actions/core';
import { parseConfig } from './config.js';
import { GitHubClient, OctokitGitHubClient } from './github/client.js';
import { PathExclusionFilter } from './security/exclusions.js';
import { parseUnifiedPatch } from './github/diff.js';
import { budgetFiles } from './review/budget.js';
import { AIProvider, Finding, ParsedPatchFile, ReviewOutcome, ReviewStatus } from './types.js';
import { GeminiProvider } from './providers/gemini.js';
import { FakeProvider } from './providers/fake.js';
import { validateAndFilterFindings } from './review/validate.js';
import { publishFindingsAndSummary } from './github/comments.js';
import { ingestStaticReports } from './analyzers/static.js';
import { SafeLogger } from './telemetry.js';

export async function runReview(customClient?: GitHubClient, customProvider?: AIProvider): Promise<ReviewOutcome> {
  const startTime = Date.now();
  let status: ReviewStatus = 'completed';
  let reasonCode: string | undefined;
  let reviewedFilesCount = 0;
  let publishedCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    // 1. Parse configuration and validate limits
    const config = parseConfig();

    if (config.providerApiKey) {
      SafeLogger.registerSecret(config.providerApiKey);
    }
    if (config.githubToken) {
      SafeLogger.registerSecret(config.githubToken);
    }

    const client = customClient ?? new OctokitGitHubClient(config.githubToken);
    const prDetails = await client.getPullRequestDetails();

    SafeLogger.info(`Starting AI code review for PR #${prDetails.pullNumber} on ${prDetails.owner}/${prDetails.repo}`);

    // 2. Validate event and PR attributes (FR-01)
    if (prDetails.eventName === 'issue_comment') {
      const comment = (prDetails.commentBody || '').trim().toLowerCase();
      const isReviewTrigger =
        comment.startsWith('/review') || comment.startsWith('/ai-review') || comment.startsWith('/recheck');

      if (!isReviewTrigger) {
        status = 'skipped';
        reasonCode = 'comment_not_a_trigger';
        SafeLogger.info(`Skipping PR #${prDetails.pullNumber}: comment is not a review trigger command`);
        return setActionOutputs({ status, reasonCode, reviewedFiles: 0, publishedFindings: 0 });
      }

      // Acknowledge review trigger with reaction
      if (prDetails.commentId && client.addCommentReaction) {
        await client.addCommentReaction(prDetails.commentId, 'eyes');
      }
    } else {
      const allowedActions = ['opened', 'synchronize', 'reopened'];
      if (!allowedActions.includes(prDetails.action)) {
        status = 'skipped';
        reasonCode = 'unsupported_pr_action';
        SafeLogger.info(`Skipping PR #${prDetails.pullNumber}: action '${prDetails.action}' is not reviewed`);
        return setActionOutputs({ status, reasonCode, reviewedFiles: 0, publishedFindings: 0 });
      }
    }

    if (prDetails.isFork) {
      status = 'skipped';
      reasonCode = 'fork_pr_skipped';
      SafeLogger.info(`Skipping PR #${prDetails.pullNumber}: fork pull requests are excluded for security`);
      return setActionOutputs({ status, reasonCode, reviewedFiles: 0, publishedFindings: 0 });
    }

    if (prDetails.isDraft) {
      status = 'skipped';
      reasonCode = 'draft_pr_skipped';
      SafeLogger.info(`Skipping PR #${prDetails.pullNumber}: draft pull requests are excluded`);
      return setActionOutputs({ status, reasonCode, reviewedFiles: 0, publishedFindings: 0 });
    }

    // 3. Provider validation & external provider opt-in check (FR-05, FR-10)
    const effectiveProvider = customProvider ? customProvider.name : config.provider;

    if (effectiveProvider === 'gemini') {
      if (!config.allowExternalProvider) {
        status = 'skipped';
        reasonCode = 'external_provider_opt_in_required';
        SafeLogger.warning(
          'Diff review skipped: allow-external-provider is false. Explicit opt-in is required before diffs leave GitHub.'
        );
        return setActionOutputs({ status, reasonCode, reviewedFiles: 0, publishedFindings: 0 });
      }

      if (!config.providerApiKey) {
        status = 'skipped';
        reasonCode = 'missing_provider_api_key';
        SafeLogger.warning('Diff review skipped: provider-api-key is required for Gemini provider.');
        return setActionOutputs({ status, reasonCode, reviewedFiles: 0, publishedFindings: 0 });
      }
    } else if (effectiveProvider !== 'fake') {
      status = 'skipped';
      reasonCode = `unsupported_provider_${effectiveProvider}`;
      SafeLogger.warning(`Diff review skipped: provider '${effectiveProvider}' is not supported in this version.`);
      return setActionOutputs({ status, reasonCode, reviewedFiles: 0, publishedFindings: 0 });
    }

    // 4. GitHub API diff collection and exclusions (FR-02, FR-03)
    const { files: ghFiles, isComplete } = await client.fetchPullRequestFiles(prDetails.pullNumber);
    if (!isComplete) {
      SafeLogger.warning('File inventory was truncated by API limits; review will proceed with partial coverage.');
      status = 'partial';
      reasonCode = 'incomplete_file_inventory';
    }

    const exclusionFilter = new PathExclusionFilter(config.excludePatterns);
    const eligiblePatchFiles: ParsedPatchFile[] = [];
    const excludedReasons: Record<string, number> = {};

    const recordExclusion = (reason: string) => {
      excludedReasons[reason] = (excludedReasons[reason] || 0) + 1;
    };

    for (const ghFile of ghFiles) {
      const filePath = ghFile.filename;

      if (prDetails.targetFile) {
        const target = prDetails.targetFile.toLowerCase();
        const normFile = filePath.toLowerCase();
        if (!normFile.includes(target) && !target.includes(normFile)) {
          continue;
        }
      }

      if (ghFile.status === 'removed') {
        recordExclusion('removed_file');
        continue;
      }

      const pathTest = exclusionFilter.testPath(filePath);
      if (pathTest.excluded) {
        recordExclusion(pathTest.reason || 'excluded_path');
        continue;
      }

      if (!ghFile.patch) {
        recordExclusion('missing_or_binary_patch');
        continue;
      }

      const patchScreen = exclusionFilter.testPatchContent(ghFile.patch);
      if (patchScreen.hasMarker) {
        recordExclusion('credential_marker_detected');
        SafeLogger.warning(`Excluded file '${filePath}' due to high-confidence credential marker detection.`);
        continue;
      }

      const parsedResult = parseUnifiedPatch(filePath, ghFile.patch, ghFile.status, ghFile.previous_filename);
      if (!parsedResult.success || !parsedResult.parsed) {
        recordExclusion('patch_parse_failed');
        continue;
      }

      eligiblePatchFiles.push(parsedResult.parsed);
    }

    if (eligiblePatchFiles.length === 0) {
      status = 'completed';
      reasonCode = 'no_eligible_files';
      SafeLogger.info('No eligible files to review after exclusions.');
      return setActionOutputs({ status, reasonCode, reviewedFiles: 0, publishedFindings: 0 });
    }

    // 5. Budget enforcement (FR-04)
    const budget = budgetFiles(eligiblePatchFiles, {
      maxFiles: config.maxFiles,
      maxFileBytes: config.maxFileBytes,
      maxInputBytes: config.maxInputBytes,
      maxInputTokens: config.maxInputTokens,
    });

    for (const skipped of budget.skippedFiles) {
      recordExclusion(skipped.reason);
    }

    if (budget.includedFiles.length === 0) {
      status = 'completed';
      reasonCode = 'all_files_exceeded_budgets';
      SafeLogger.info('All eligible files exceeded configured size or token budgets.');
      return setActionOutputs({ status, reasonCode, reviewedFiles: 0, publishedFindings: 0 });
    }

    reviewedFilesCount = budget.includedFiles.length;
    inputTokens = budget.estimatedTokens;
    SafeLogger.info(`Reviewing ${reviewedFilesCount} files (~${inputTokens} estimated input tokens)`);

    const filePatchMap = new Map<string, ParsedPatchFile>();
    for (const file of budget.includedFiles) {
      filePatchMap.set(file.path, file);
    }

    // 6. Provider execution with 60-second timeout (FR-05)
    let provider: AIProvider;
    if (customProvider) {
      provider = customProvider;
    } else if (config.provider === 'gemini') {
      provider = new GeminiProvider({
        apiKey: config.providerApiKey,
        model: config.model,
        maxOutputTokens: config.maxOutputTokens,
      });
    } else {
      provider = new FakeProvider();
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 60000); // 60s provider timeout

    let rawFindings: Finding[] = [];
    try {
      const reviewInput = {
        files: budget.includedFiles.map((f) => ({ path: f.path, patch: f.patch })),
        maxFindings: config.maxFindings,
        language: config.reviewLanguage,
      };

      const result = await provider.review(reviewInput, abortController.signal);
      rawFindings = result.findings;
      if (result.usage?.inputTokens) inputTokens = result.usage.inputTokens;
      if (result.usage?.outputTokens) outputTokens = result.usage.outputTokens;
    } catch (providerErr: unknown) {
      clearTimeout(timeout);
      SafeLogger.error(`Provider review failed: ${(providerErr as Error).message}`);
      status = 'partial';
      reasonCode = 'provider_request_failed';
      return setActionOutputs({
        status,
        reasonCode,
        reviewedFiles: reviewedFilesCount,
        publishedFindings: 0,
        inputTokens,
        outputTokens,
      });
    } finally {
      clearTimeout(timeout);
    }

    // 7. Optional static analysis report ingestion (FR-09)
    if (config.staticReportPaths.length > 0) {
      SafeLogger.info(`Ingesting ${config.staticReportPaths.length} static report path(s)...`);
      const staticResult = ingestStaticReports({
        reportPaths: config.staticReportPaths,
        expectedHeadSha: prDetails.headSha,
        filePatchMap,
      });
      SafeLogger.info(`Ingested ${staticResult.findings.length} findings from ${staticResult.processedReports} report(s)`);
      rawFindings.push(...staticResult.findings);
    }

    // 8. Runtime schema & added-line validation (FR-06, FR-07)
    const { validFindings, droppedFindings } = validateAndFilterFindings(rawFindings, { filePatchMap });
    if (droppedFindings.length > 0) {
      SafeLogger.info(`Dropped ${droppedFindings.length} invalid findings (out of bounds or malformed)`);
    }

    // 9. Reconcile, deduplicate, recheck head SHA and publish comments (FR-07, FR-08, FR-12)
    const repoFullName = `${prDetails.owner}/${prDetails.repo}`;
    const publishResult = await publishFindingsAndSummary(
      client,
      repoFullName,
      prDetails.pullNumber,
      prDetails.headSha,
      validFindings,
      {
        status,
        reasonCode,
        model: config.model,
        provider: effectiveProvider,
        reviewedFiles: reviewedFilesCount,
        totalChangedFiles: ghFiles.length,
        skippedFilesCount: ghFiles.length - reviewedFilesCount,
        excludedReasons,
        inputTokens,
        outputTokens,
      },
      config.maxFindings
    );

    if (publishResult.staleHead) {
      status = 'partial';
      reasonCode = 'stale_head_discarded';
      SafeLogger.warning('PR head changed during review execution; findings were safely discarded.');
      return setActionOutputs({
        status,
        reasonCode,
        reviewedFiles: reviewedFilesCount,
        publishedFindings: 0,
        inputTokens,
        outputTokens,
      });
    }

    publishedCount = publishResult.publishedCount;
    SafeLogger.info(`Published ${publishedCount} new inline findings (deduped: ${publishResult.dedupedCount})`);

    const durationMs = Date.now() - startTime;
    SafeLogger.logMetrics({
      eventName: 'review_completed',
      durationMs,
      reviewedFilesCount,
      totalFindingsCount: validFindings.length,
      publishedFindingsCount: publishedCount,
      inputTokens,
      outputTokens,
      status,
      reasonCode,
    });

    if (prDetails.commentId && client.addCommentReaction) {
      await client.addCommentReaction(prDetails.commentId, 'rocket');
    }

    return setActionOutputs({
      status,
      reasonCode,
      reviewedFiles: reviewedFilesCount,
      publishedFindings: publishedCount,
      inputTokens,
      outputTokens,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown fatal error';
    SafeLogger.error(`Action execution failed: ${errorMsg}`);
    status = 'failed';
    reasonCode = 'unexpected_error';

    return setActionOutputs({
      status,
      reasonCode,
      reviewedFiles: reviewedFilesCount,
      publishedFindings: publishedCount,
      inputTokens,
      outputTokens,
    });
  }
}

function setActionOutputs(outcome: ReviewOutcome): ReviewOutcome {
  core.setOutput('status', outcome.status);
  if (outcome.reasonCode) {
    core.setOutput('reason-code', outcome.reasonCode);
  }
  core.setOutput('reviewed-files', String(outcome.reviewedFiles));
  core.setOutput('published-findings', String(outcome.publishedFindings));
  if (outcome.inputTokens !== undefined) {
    core.setOutput('input-tokens', String(outcome.inputTokens));
  }
  if (outcome.outputTokens !== undefined) {
    core.setOutput('output-tokens', String(outcome.outputTokens));
  }
  return outcome;
}

// Top level execution when run directly by GitHub Actions runner
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  runReview().catch((err) => {
    core.setFailed(err instanceof Error ? err.message : String(err));
  });
}
