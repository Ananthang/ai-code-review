import { collectContext } from './review/context.js';
import { reviewPolicyKey, fileKey, readCheckpoint, checkpointMarker } from './review/incremental.js';
import * as core from '@actions/core';
import { reactToReviewStart } from './github/reactions.js';
import { hasPromptInjection } from './security/ai-guard.js';
import { parseConfig } from './config.js';
import { GitHubClient, OctokitGitHubClient } from './github/client.js';
import { PathExclusionFilter } from './security/exclusions.js';
import { parseUnifiedPatch } from './github/diff.js';
import { buildReviewPrompt, SYSTEM_INSTRUCTION } from './review/prompt.js';
import { budgetFiles } from './review/budget.js';
import { AIProvider, Finding, ParsedPatchFile, ReviewInput, ReviewOutcome, ReviewStatus } from './types.js';
import { createProvider } from './providers/factory.js';
import { HttpProvider } from './providers/http.js';
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
  // Read this before validation so malformed configuration also respects fail-on-error.
  let failOnError = ['true', '1', 'yes'].includes(core.getInput('fail-on-error').trim().toLowerCase());
  const finish = (outcome: ReviewOutcome): ReviewOutcome => {
    const result = setActionOutputs(outcome);
    if (failOnError && (outcome.status === 'failed' || outcome.status === 'partial')) {
      core.setFailed(`AI Code Review incomplete: ${outcome.reasonCode ?? outcome.status}`);
    }
    return result;
  };

  try {
    // 1. Parse configuration and validate limits
    const config = parseConfig();
    failOnError = config.failOnError;

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
        /^\/(?:review|ai-review|recheck)(?:\s+.*)?$/i.test(comment);

      if (!isReviewTrigger) {
        status = 'skipped';
        reasonCode = 'comment_not_a_trigger';
        SafeLogger.info(`Skipping PR #${prDetails.pullNumber}: comment is not a review trigger command`);
        return finish({ status, reasonCode, reviewedFiles: 0, publishedFindings: 0 });
      }

      if (prDetails.action !== 'created' || !prDetails.mayTriggerReview) {
        return finish({ status: 'skipped', reasonCode: 'comment_trigger_not_authorized', reviewedFiles: 0, publishedFindings: 0 });
      }

    } else {
      if (prDetails.eventName !== 'pull_request') {
        return finish({ status: 'skipped', reasonCode: 'unsupported_event', reviewedFiles: 0, publishedFindings: 0 });
      }
      const allowedActions = ['opened', 'synchronize', 'reopened'];
      if (!allowedActions.includes(prDetails.action)) {
        status = 'skipped';
        reasonCode = 'unsupported_pr_action';
        SafeLogger.info(`Skipping PR #${prDetails.pullNumber}: action '${prDetails.action}' is not reviewed`);
        return finish({ status, reasonCode, reviewedFiles: 0, publishedFindings: 0 });
      }
    }

    if (prDetails.isFork) {
      status = 'skipped';
      reasonCode = 'fork_pr_skipped';
      SafeLogger.info(`Skipping PR #${prDetails.pullNumber}: fork pull requests are excluded for security`);
      return finish({ status, reasonCode, reviewedFiles: 0, publishedFindings: 0 });
    }

    if (prDetails.isDraft) {
      status = 'skipped';
      reasonCode = 'draft_pr_skipped';
      SafeLogger.info(`Skipping PR #${prDetails.pullNumber}: draft pull requests are excluded`);
      return finish({ status, reasonCode, reviewedFiles: 0, publishedFindings: 0 });
    }

    // 3. Provider validation & external provider opt-in check (FR-05, FR-10)
    const effectiveProvider = customProvider ? customProvider.name : config.provider;

    if (['gemini', 'openai', 'anthropic'].includes(effectiveProvider)) {
      if (!config.allowExternalProvider) {
        status = 'skipped';
        reasonCode = 'external_provider_opt_in_required';
        SafeLogger.warning(
          'Diff review skipped: allow-external-provider is false. Explicit opt-in is required before diffs leave GitHub.'
        );
        return finish({ status, reasonCode, reviewedFiles: 0, publishedFindings: 0 });
      }

      if (!config.providerApiKey) {
        status = 'skipped';
        reasonCode = 'missing_provider_api_key';
        SafeLogger.warning('Diff review skipped: provider-api-key is required for the selected provider.');
        return finish({ status, reasonCode, reviewedFiles: 0, publishedFindings: 0 });
      }
    } else if (!['fake', 'ollama'].includes(effectiveProvider)) {
      status = 'skipped';
      reasonCode = `unsupported_provider_${effectiveProvider}`;
      SafeLogger.warning(`Diff review skipped: provider '${effectiveProvider}' is not supported in this version.`);
      return finish({ status, reasonCode, reviewedFiles: 0, publishedFindings: 0 });
    }

    // 4. GitHub API diff collection and exclusions (FR-02, FR-03)
    const { files: ghFiles, isComplete } = await client.fetchPullRequestFiles(prDetails.pullNumber);
    if (!isComplete) {
      return finish({ status: 'skipped', reasonCode: 'incomplete_file_inventory', reviewedFiles: 0, publishedFindings: 0 });
    }

    const exclusionFilter = new PathExclusionFilter(config.excludePatterns);
    const eligiblePatchFiles: ParsedPatchFile[] = [];
    const excludedReasons: Record<string, number> = {};

    const recordExclusion = (reason: string) => {
      excludedReasons[reason] = (excludedReasons[reason] || 0) + 1;
    };

    const isTargetFileInPR = prDetails.targetFile && ghFiles.some((f) => f.filename === prDetails.targetFile);
    if (prDetails.targetFile && !isTargetFileInPR) {
      return finish({ status: 'skipped', reasonCode: 'target_file_not_found', reviewedFiles: 0, publishedFindings: 0 });
    }
    const effectiveTargetFile = prDetails.targetFile;

    for (const ghFile of ghFiles) {
      const filePath = ghFile.filename;

      if (effectiveTargetFile) {
        if (filePath !== effectiveTargetFile) {
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

      if (hasPromptInjection(filePath + '\n' + ghFile.patch)) {
        recordExclusion('ai_guard_prompt_injection');
        status = 'partial';
        reasonCode = 'ai_guard_files_skipped';
        continue;
      }

      const patchScreen = exclusionFilter.testPatchContent(ghFile.patch);
      if (patchScreen.hasMarker) {
        recordExclusion('credential_marker_detected');
        SafeLogger.warning('Excluded a patch containing a credential marker.');
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
      status = 'skipped';
      reasonCode = excludedReasons.ai_guard_prompt_injection ? 'ai_guard_files_skipped' : 'no_eligible_files';
      SafeLogger.info('No eligible files to review after exclusions.');
      return finish({ status, reasonCode, reviewedFiles: 0, publishedFindings: 0 });
    }

    // Context is bounded, screened and fetched at an immutable PR SHA.
    const availableContext = await collectContext(client, prDetails.headSha,
      eligiblePatchFiles, exclusionFilter, config.maxContextBytes ?? 2048);
    const policyKey = reviewPolicyKey(config, prDetails.baseSha, availableContext);
    let relatedContext: Array<{ path: string; content: string }> = [];
    let previousKeys = new Set<string>();
    // Manual commands deliberately force a fresh review, including targeted requests.
    if (config.incremental && prDetails.eventName === 'pull_request' && !config.staticReportPaths.length) {
      try { previousKeys = readCheckpoint(await client.fetchIssueComments(prDetails.pullNumber), policyKey); }
      catch { /* Missing state falls back to a full bounded review. */ }
    }
    const pendingFiles = eligiblePatchFiles.filter(file => !previousKeys.has(fileKey(file)));
    const incrementalSkipped = eligiblePatchFiles.length - pendingFiles.length;
    if (!pendingFiles.length) {
      return finish({ status: status === 'partial' ? status : 'skipped', reasonCode: reasonCode ?? 'unchanged_since_review', reviewedFiles: 0, publishedFindings: 0 });
    }

    // 5. Budget enforcement (FR-04)
    const provider = customProvider ?? createProvider(config);
    const measureInput = (files: ReviewInput['files'], context = relatedContext) => {
      const input = { files, maxFindings: config.maxFindings, language: config.reviewLanguage,
        customInstructions: config.customInstructions, relatedContext: context,
        minSeverity: config.minSeverity, requireEvidence: config.requireEvidence };
      return Buffer.byteLength(provider instanceof HttpProvider
        ? JSON.stringify(provider.requestBody(input)) : SYSTEM_INSTRUCTION + buildReviewPrompt(input), 'utf8');
    };
    const budget = budgetFiles(pendingFiles, {
      maxFiles: config.maxFiles,
      maxFileBytes: config.maxFileBytes,
      maxInputBytes: config.maxInputBytes,
      maxInputTokens: config.maxInputTokens,
      measureInput,
    });

    for (const skipped of budget.skippedFiles) {
      recordExclusion(skipped.reason);
    }

    if (budget.includedFiles.length === 0) {
      status = 'skipped';
      reasonCode = 'all_files_exceeded_budgets';
      SafeLogger.info('All eligible files exceeded configured size or token budgets.');

      const repoFullName = `${prDetails.owner}/${prDetails.repo}`;
      try {
        const skippedPublication = await publishFindingsAndSummary(
          client,
          repoFullName,
          prDetails.pullNumber,
          prDetails.headSha,
          [],
          {
            status,
            reasonCode,
            model: config.model,
            provider: effectiveProvider,
            reviewedFiles: 0,
            totalChangedFiles: ghFiles.length,
            skippedFilesCount: ghFiles.length,
            excludedReasons,
            inputTokens: 0,
            outputTokens: 0,
          },
          config.maxFindings
        );
        if (skippedPublication.errors.length || skippedPublication.staleHead) {
          status = 'partial';
          reasonCode = skippedPublication.staleHead ? 'stale_head_discarded' : 'publication_incomplete';
        }
      } catch {
        status = 'partial';
        reasonCode = 'publication_incomplete';
      }

      return finish({ status, reasonCode, reviewedFiles: 0, publishedFindings: 0 });
    }

    // Diff coverage takes priority; optional context uses only the remaining request budget.
    const selectedFiles = budget.includedFiles.map(({ path, patch }) => ({ path, patch }));
    for (const context of availableContext) {
      const candidate = [...relatedContext, context];
      const bytes = measureInput(selectedFiles, candidate);
      if (bytes <= config.maxInputBytes && bytes <= config.maxInputTokens) relatedContext = candidate;
    }
    budget.estimatedTokens = measureInput(selectedFiles);

    reviewedFilesCount = budget.includedFiles.length;
    inputTokens = budget.estimatedTokens;
    SafeLogger.info(`Reviewing ${reviewedFilesCount} files (~${inputTokens} estimated input tokens)`);

    const filePatchMap = new Map<string, ParsedPatchFile>();
    for (const file of budget.includedFiles) {
      filePatchMap.set(file.path, file);
    }

    await reactToReviewStart(client, prDetails);

    if (config.customInstructions) {
      SafeLogger.info('Applying custom review guidelines / instructions.');
    }

    let effectiveModel = config.model;
    let fallbackFromModel: string | undefined;
    let fallbackReason: string | undefined;

    SafeLogger.info(`Sending ${reviewedFilesCount} file(s) to ${effectiveProvider} (${config.model || 'default'})...`);

    // 6. Provider execution with 120-second timeout (gives reasoning models like gemini-3.8-flash sufficient time)
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 120000); // 120s provider timeout

    let rawFindings: Finding[] = [];
    let aiSummary: string | undefined;
    let reviewSucceeded = false;
    try {
      const reviewInput: ReviewInput = {
        files: budget.includedFiles.map((f) => ({ path: f.path, patch: f.patch })),
        maxFindings: config.maxFindings,
        language: config.reviewLanguage,
        customInstructions: config.customInstructions,
        relatedContext, minSeverity: config.minSeverity, requireEvidence: config.requireEvidence,
      };

      const result = await provider.review(reviewInput, abortController.signal);
      SafeLogger.info('AI review response received from provider. Validating findings...');
      rawFindings = result.findings;
      aiSummary = result.summary;
      if (result.usage?.inputTokens) inputTokens = result.usage.inputTokens;
      if (result.usage?.outputTokens) outputTokens = result.usage.outputTokens;
      reviewSucceeded = true;
    } catch (providerErr: unknown) {
      clearTimeout(timeout);
      const isAbort =
        providerErr instanceof Error &&
        (providerErr.name === 'AbortError' || providerErr.message.includes('aborted'));
      let code = isAbort
        ? 'timeout'
        : providerErr instanceof Error && providerErr.message
          ? providerErr.message
          : 'provider_request_failed';

      // If rate limited (429) or overloaded (503) and an explicit fallback model is configured, attempt fallback
      const isCapacityError =
        code === 'provider_http_429' ||
        code.includes('429') ||
        code === 'provider_http_503' ||
        code.includes('503');

      const cleanPrimary = config.model.replace(/^models\//, '').trim();
      const cleanFallback = (config.fallbackModel || '').replace(/^models\//, '').trim();

      if (
        isCapacityError &&
        cleanFallback &&
        cleanFallback !== cleanPrimary &&
        !customProvider &&
        config.maxRequests >= 2
      ) {
        const fallbackTargetModel = config.fallbackModel!;
        const errorLabel = code.includes('503') ? 'overloaded (503)' : 'rate limited (429)';
        SafeLogger.warning(
          `Primary model "${config.model}" ${errorLabel}. Attempting configured fallback model: "${fallbackTargetModel}"...`
        );
        const fallbackAbortController = new AbortController();
        const fallbackTimeout = setTimeout(() => fallbackAbortController.abort(), 120000);
        try {
          const fallbackProvider = createProvider({
            ...config,
            model: fallbackTargetModel,
          });
          const reviewInput: ReviewInput = {
            files: budget.includedFiles.map((f) => ({ path: f.path, patch: f.patch })),
            maxFindings: config.maxFindings,
            language: config.reviewLanguage,
            customInstructions: config.customInstructions,
            relatedContext, minSeverity: config.minSeverity, requireEvidence: config.requireEvidence,
          };
          const fbResult = await fallbackProvider.review(reviewInput, fallbackAbortController.signal);
          clearTimeout(fallbackTimeout);
          SafeLogger.info('AI review response received from fallback model. Validating findings...');
          rawFindings = fbResult.findings;
          aiSummary = fbResult.summary;
          if (fbResult.usage?.inputTokens) inputTokens = fbResult.usage.inputTokens;
          if (fbResult.usage?.outputTokens) outputTokens = fbResult.usage.outputTokens;
          effectiveModel = fallbackTargetModel;
          fallbackFromModel = config.model;
          fallbackReason = code;
          reviewSucceeded = true;
        } catch (fallbackErr: unknown) {
          clearTimeout(fallbackTimeout);
          const isFbAbort =
            fallbackErr instanceof Error &&
            (fallbackErr.name === 'AbortError' || fallbackErr.message.includes('aborted'));
          code = isFbAbort
            ? 'timeout'
            : fallbackErr instanceof Error && fallbackErr.message
              ? fallbackErr.message
              : 'provider_request_failed';
          SafeLogger.error(`Fallback model "${fallbackTargetModel}" also failed (${code}).`);
        }
      }

      if (!reviewSucceeded) {
        SafeLogger.error(`Provider review failed (${code}); response and error body withheld.`);
        status = 'partial';
        reasonCode = code;

        const repoFullName = `${prDetails.owner}/${prDetails.repo}`;
        try {
          await publishFindingsAndSummary(
            client,
            repoFullName,
            prDetails.pullNumber,
            prDetails.headSha,
            [],
            {
              status,
              reasonCode,
              model: effectiveModel,
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
        } catch {
          // Safe fallback if GitHub comment publishing fails
        }


        return finish({
          status,
          reasonCode,
          reviewedFiles: reviewedFilesCount,
          publishedFindings: 0,
          inputTokens,
          outputTokens,
        });
      }
    } finally {
      clearTimeout(timeout);
    }

    let staticFindings: Finding[] = [];
    // 7. Optional static analysis report ingestion (FR-09)
    if (config.staticReportPaths.length > 0) {
      SafeLogger.info(`Ingesting ${config.staticReportPaths.length} static report path(s)...`);
      const staticResult = ingestStaticReports({
        reportPaths: config.staticReportPaths,
        expectedHeadSha: prDetails.headSha,
        filePatchMap,
      });
      SafeLogger.info(`Ingested ${staticResult.findings.length} findings from ${staticResult.processedReports} report(s)`);
      if (staticResult.skippedReports.length) { status = 'partial'; reasonCode = 'static_reports_skipped'; }
      staticFindings = staticResult.findings;
    }

    // 8. Runtime schema & added-line validation (FR-06, FR-07)
    const { validFindings, droppedFindings } = validateAndFilterFindings(rawFindings, { filePatchMap, minSeverity: config.minSeverity, requireEvidence: config.requireEvidence });
    const staticValidation = validateAndFilterFindings(staticFindings, { filePatchMap, minSeverity: config.minSeverity });
    validFindings.push(...staticValidation.validFindings);
    droppedFindings.push(...staticValidation.droppedFindings);
    if (droppedFindings.length > 0) {
      status = 'partial';
      reasonCode = 'invalid_findings_dropped';
      SafeLogger.warning(`Dropped ${droppedFindings.length} invalid finding(s) (out of bounds or malformed):`);
      for (const d of droppedFindings) {
        SafeLogger.warning(`- ${d.reason}`);
      }
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
        model: effectiveModel,
        provider: effectiveProvider,
        reviewedFiles: reviewedFilesCount,
        totalChangedFiles: ghFiles.length,
        skippedFilesCount: ghFiles.length - reviewedFilesCount,
        excludedReasons,
        inputTokens,
        outputTokens,
        overview: aiSummary,
        fallbackFromModel,
        fallbackReason,
        incrementalSkipped,
        contextFiles: relatedContext.length,
        checkpoint: status === 'completed' && !config.staticReportPaths.length
          ? checkpointMarker(policyKey, [...previousKeys, ...budget.includedFiles.map(fileKey)]) : undefined,
      },
      config.maxFindings
    );

    if (publishResult.staleHead) {
      status = 'partial';
      reasonCode = 'stale_head_discarded';
      SafeLogger.warning('PR head changed during review execution; findings were safely discarded.');

      return finish({
        status,
        reasonCode,
        reviewedFiles: reviewedFilesCount,
        publishedFindings: 0,
        inputTokens,
        outputTokens,
      });
    }

    if (publishResult.errors.length) { status = 'partial'; reasonCode = 'publication_incomplete'; }
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

    return finish({
      status,
      reasonCode,
      reviewedFiles: reviewedFilesCount,
      publishedFindings: publishedCount,
      inputTokens,
      outputTokens,
    });
  } catch (err: unknown) {
    SafeLogger.error('Action execution failed; error details withheld to protect source and credentials.');
    status = 'failed';
    reasonCode = 'unexpected_error';

    return finish({
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
    core.error('Action could not report its outcome.');
  });
}
