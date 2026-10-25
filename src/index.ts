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

export function getOutcomeDetails(status: ReviewStatus, reasonCode?: string): { explanation: string; nextStep: string } {
  switch (reasonCode) {
    case 'fork_pr_skipped':
      return {
        explanation: 'Fork pull requests are excluded to prevent secret exposure and untrusted execution.',
        nextStep: 'Maintainers can test changes on a local or trusted branch.',
      };
    case 'draft_pr_skipped':
      return {
        explanation: 'Draft pull requests are skipped to conserve review quotas on work-in-progress code.',
        nextStep: 'Mark the pull request as "Ready for review" and comment /review to trigger a review.',
      };
    case 'comment_not_a_trigger':
      return {
        explanation: 'The comment was not a recognized review command.',
        nextStep: 'Use "/review" or "/review <path>" to trigger an on-demand review.',
      };
    case 'comment_trigger_not_authorized':
      return {
        explanation: 'The comment author does not have write or maintain access to this repository.',
        nextStep: 'Only authorized repository collaborators may trigger AI reviews via comment.',
      };
    case 'unsupported_pr_action':
      return {
        explanation: 'Only pull request opened, synchronize, or reopened actions are reviewed.',
        nextStep: 'Push new commits to the branch or comment /review to re-trigger.',
      };
    case 'unsupported_event':
      return {
        explanation: 'The workflow was triggered by an event other than pull_request or issue_comment.',
        nextStep: 'Ensure workflow triggers include pull_request and issue_comment.',
      };
    case 'external_provider_opt_in_required':
      return {
        explanation: 'allow-external-provider is false; explicit opt-in is required before diffs leave GitHub.',
        nextStep: 'Set "allow-external-provider: true" in your workflow step inputs.',
      };
    case 'missing_provider_api_key':
      return {
        explanation: 'No API key was supplied for the selected external AI provider.',
        nextStep: 'Provide provider-api-key in workflow inputs via repository secrets (e.g. AI_PROVIDER_API_KEY).',
      };
    case 'no_eligible_files':
      return {
        explanation: 'No eligible files remained to review after applying path and credential exclusions.',
        nextStep: 'Ensure changes modify non-excluded, non-binary source files.',
      };
    case 'ai_guard_files_skipped':
      return {
        explanation: 'Files containing recognized prompt injection patterns were excluded from review.',
        nextStep: 'Inspect excluded diffs manually for adversarial content or prompt injection.',
      };
    case 'target_file_not_found':
      return {
        explanation: 'The file specified in /review <file> was not modified in this pull request.',
        nextStep: 'Verify the file path against the PR diff and try again.',
      };
    case 'all_files_exceeded_budgets':
      return {
        explanation: 'All modified files exceeded configured per-file size or total input token budgets.',
        nextStep: 'Review individual files using "/review <path>" or increase max-input-tokens / max-file-bytes.',
      };
    case 'unchanged_since_review':
      return {
        explanation: 'All eligible files were previously reviewed at matching policy and remain unchanged.',
        nextStep: 'Push new commits or comment /review to force a fresh review.',
      };
    case 'provider_http_429':
      return {
        explanation: 'AI provider rate limit or quota ceiling was exceeded (HTTP 429).',
        nextStep: 'Wait 1 to 2 minutes for rate-limit reset, then comment /review on this PR.',
      };
    case 'provider_http_503':
      return {
        explanation: 'Upstream AI provider reported temporary service unavailability or capacity limits (HTTP 503).',
        nextStep: 'Wait 15 to 30 seconds and comment /review on this PR to retry.',
      };
    case 'invalid_findings_dropped':
      return {
        explanation: 'One or more findings from the AI provider failed schema validation or added-line checks.',
        nextStep: 'Valid findings were published; invalid/ungrounded findings were dropped.',
      };
    case 'stale_head_discarded':
      return {
        explanation: 'PR head commit changed during execution; findings for the obsolete commit were discarded.',
        nextStep: 'The latest commit will be reviewed automatically or can be re-triggered by commenting /review.',
      };
    case 'publication_incomplete':
      return {
        explanation: 'One or more review comments could not be published to GitHub API.',
        nextStep: 'Ensure GITHUB_TOKEN has pull-requests:write and issues:write permissions.',
      };
    case 'unexpected_error':
    case 'timeout':
      return {
        explanation: 'Review execution failed or exceeded the request timeout.',
        nextStep: 'Check workflow run details and comment /review to retry.',
      };
    default:
      if (status === 'completed') {
        return {
          explanation: 'AI code review completed successfully within configured budgets.',
          nextStep: 'Review published inline comments and summary table on the pull request.',
        };
      }
      return {
        explanation: `Review finished with status "${status}" (${reasonCode ?? 'no reason code'}).`,
        nextStep: 'Check logs above and re-trigger with /review if needed.',
      };
  }
}

export async function runReview(customClient?: GitHubClient, customProvider?: AIProvider): Promise<ReviewOutcome> {
  const startTime = Date.now();
  let status: ReviewStatus = 'completed';
  let reasonCode: string | undefined;
  let reviewedFilesCount = 0;
  let publishedCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let providerReportedUsage = false;
  // Read this before validation so malformed configuration also respects fail-on-error.
  let failOnError = ['true', '1', 'yes'].includes(core.getInput('fail-on-error').trim().toLowerCase());

  const finish = (outcome: ReviewOutcome): ReviewOutcome => {
    SafeLogger.closeAllGroups();
    const durationMs = Date.now() - startTime;
    const { explanation, nextStep } = getOutcomeDetails(outcome.status, outcome.reasonCode);
    SafeLogger.info(`Outcome: ${outcome.status}${outcome.reasonCode ? ` (${outcome.reasonCode})` : ''} - ${explanation}`);
    SafeLogger.info(`Next step: ${nextStep} (elapsed: ${durationMs}ms)`);

    const result = setActionOutputs(outcome);
    if (failOnError && (outcome.status === 'failed' || outcome.status === 'partial')) {
      core.setFailed(`AI Code Review incomplete: ${outcome.reasonCode ?? outcome.status}`);
    }
    return result;
  };

  try {
    // 1. Setup & Configuration Section
    SafeLogger.startGroup('Setup & Configuration');
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

    SafeLogger.info(`Target: PR #${prDetails.pullNumber} on ${prDetails.owner}/${prDetails.repo}`);
    SafeLogger.info(`Provider: ${config.provider} | Model: ${config.model || 'default'} | Fallback: ${config.fallbackModel || 'none'}`);
    SafeLogger.info(`Budgets: max-files=${config.maxFiles}, max-file-bytes=${config.maxFileBytes}, max-input-tokens=${config.maxInputTokens}, max-requests=${config.maxRequests}`);
    SafeLogger.info(`Policies: min-severity=${config.minSeverity ?? 'medium'}, require-evidence=${config.requireEvidence ?? true}, incremental=${config.incremental ?? true}`);
    if (config.upgradeNotice) {
      core.notice(config.upgradeNotice, { title: 'AI Code Review: Upgrade Recommended' });
      SafeLogger.warning(`Upgrade notice active: ${config.upgradeNotice}`);
    }
    SafeLogger.endGroup();

    // 2. Security & Authorization Section
    SafeLogger.startGroup('Security & Authorization');
    SafeLogger.info(`Event: ${prDetails.eventName} | Action: ${prDetails.action} | Base SHA: ${prDetails.baseSha.slice(0, 7)} | Head SHA: ${prDetails.headSha.slice(0, 7)}`);

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
        SafeLogger.warning(`Skipping PR #${prDetails.pullNumber}: comment author is not authorized to trigger reviews`);
        return finish({ status: 'skipped', reasonCode: 'comment_trigger_not_authorized', reviewedFiles: 0, publishedFindings: 0 });
      }

    } else {
      if (prDetails.eventName !== 'pull_request') {
        SafeLogger.warning(`Skipping: event '${prDetails.eventName}' is not supported`);
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
    SafeLogger.info('Security checks passed: repository event authorized, external provider permissions verified.');
    SafeLogger.endGroup();

    // 3. File Selection & Exclusions Section
    SafeLogger.startGroup('File Selection & Exclusions');
    const { files: ghFiles, isComplete } = await client.fetchPullRequestFiles(prDetails.pullNumber);
    if (!isComplete) {
      SafeLogger.warning('Pull request file inventory was incomplete.');
      return finish({ status: 'skipped', reasonCode: 'incomplete_file_inventory', reviewedFiles: 0, publishedFindings: 0 });
    }

    SafeLogger.info(`Fetched ${ghFiles.length} changed file(s) from GitHub API.`);

    const exclusionFilter = new PathExclusionFilter(config.excludePatterns);
    const eligiblePatchFiles: ParsedPatchFile[] = [];
    const excludedReasons: Record<string, number> = {};

    const recordExclusion = (reason: string) => {
      excludedReasons[reason] = (excludedReasons[reason] || 0) + 1;
    };

    const isTargetFileInPR = prDetails.targetFile && ghFiles.some((f) => f.filename === prDetails.targetFile);
    if (prDetails.targetFile && !isTargetFileInPR) {
      SafeLogger.warning(`Target file "${prDetails.targetFile}" requested in /review command was not found in PR changes.`);
      return finish({ status: 'skipped', reasonCode: 'target_file_not_found', reviewedFiles: 0, publishedFindings: 0 });
    }
    const effectiveTargetFile = prDetails.targetFile;
    if (effectiveTargetFile) {
      SafeLogger.info(`Target file filter active: reviewing only "${effectiveTargetFile}".`);
    }

    for (const ghFile of ghFiles) {
      const filePath = ghFile.filename;

      if (effectiveTargetFile && filePath !== effectiveTargetFile) {
        continue;
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

    SafeLogger.info(`Eligible patch files: ${eligiblePatchFiles.length} of ${ghFiles.length}`);
    const exclusionEntries = Object.entries(excludedReasons);
    if (exclusionEntries.length > 0) {
      SafeLogger.info(`Exclusions breakdown: ${exclusionEntries.map(([r, c]) => `${r}=${c}`).join(', ')}`);
    }

    if (eligiblePatchFiles.length === 0) {
      status = 'skipped';
      reasonCode = excludedReasons.ai_guard_prompt_injection ? 'ai_guard_files_skipped' : 'no_eligible_files';
      SafeLogger.info('No eligible files to review after exclusions.');
      return finish({ status, reasonCode, reviewedFiles: 0, publishedFindings: 0 });
    }
    SafeLogger.endGroup();

    // 4. Budget & Context Selection Section
    SafeLogger.startGroup('Budget & Context Selection');
    const availableContext = await collectContext(client, prDetails.headSha,
      eligiblePatchFiles, exclusionFilter, config.maxContextBytes ?? 2048);
    const policyKey = reviewPolicyKey(config, prDetails.baseSha, availableContext);
    let relatedContext: Array<{ path: string; content: string }> = [];
    let previousKeys = new Set<string>();

    if (config.incremental && prDetails.eventName === 'pull_request' && !config.staticReportPaths.length) {
      try { previousKeys = readCheckpoint(await client.fetchIssueComments(prDetails.pullNumber), policyKey); }
      catch { /* Missing state falls back to a full bounded review. */ }
    }
    const pendingFiles = eligiblePatchFiles.filter(file => !previousKeys.has(fileKey(file)));
    const incrementalSkipped = eligiblePatchFiles.length - pendingFiles.length;
    if (incrementalSkipped > 0) {
      SafeLogger.info(`Incremental checkpoint match: ${incrementalSkipped} unchanged file(s) skipped.`);
    }

    if (!pendingFiles.length) {
      SafeLogger.info('All eligible files were reviewed in previous checkpoint; nothing to review.');
      return finish({ status: status === 'partial' ? status : 'skipped', reasonCode: reasonCode ?? 'unchanged_since_review', reviewedFiles: 0, publishedFindings: 0 });
    }

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
            upgradeNotice: config.upgradeNotice,
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

    const selectedFiles = budget.includedFiles.map(({ path, patch }) => ({ path, patch }));
    for (const context of availableContext) {
      const candidate = [...relatedContext, context];
      const bytes = measureInput(selectedFiles, candidate);
      if (bytes <= config.maxInputBytes && bytes <= config.maxInputTokens) relatedContext = candidate;
    }
    budget.estimatedTokens = measureInput(selectedFiles);

    reviewedFilesCount = budget.includedFiles.length;
    inputTokens = budget.estimatedTokens;
    SafeLogger.info(`Selected ${reviewedFilesCount} file(s) for review (~${inputTokens} conservative estimated input tokens).`);
    SafeLogger.info(`Related context files: ${relatedContext.length} included out of ${availableContext.length} candidate(s).`);
    SafeLogger.endGroup();

    const filePatchMap = new Map<string, ParsedPatchFile>();
    for (const file of budget.includedFiles) {
      filePatchMap.set(file.path, file);
    }

    await reactToReviewStart(client, prDetails);

    if (config.customInstructions) {
      SafeLogger.info('Custom review instructions / guidelines active.');
    }

    let effectiveModel = config.model;
    let fallbackFromModel: string | undefined;
    let fallbackReason: string | undefined;

    // 5. Provider Execution Section
    SafeLogger.startGroup('Provider Execution');
    SafeLogger.info(`Sending ${reviewedFilesCount} file(s) to ${effectiveProvider} (${config.model || 'default'}) [attempt 1 of ${config.maxRequests}]...`);

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 120000); // 120s provider timeout

    let rawFindings: Finding[] = [];
    let aiSummary: string | undefined;
    let reviewSucceeded = false;
    const providerStartTime = Date.now();

    try {
      const reviewInput: ReviewInput = {
        files: budget.includedFiles.map((f) => ({ path: f.path, patch: f.patch })),
        maxFindings: config.maxFindings,
        language: config.reviewLanguage,
        customInstructions: config.customInstructions,
        relatedContext, minSeverity: config.minSeverity, requireEvidence: config.requireEvidence,
      };

      const result = await provider.review(reviewInput, abortController.signal);
      const providerDuration = Date.now() - providerStartTime;
      SafeLogger.info(`AI review response received from provider (${providerDuration}ms).`);
      rawFindings = result.findings;
      aiSummary = result.summary;
      if (result.usage?.inputTokens) {
        inputTokens = result.usage.inputTokens;
        providerReportedUsage = true;
      }
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
        const errorLabel = code.includes('503') ? 'capacity limit (HTTP 503)' : 'rate limit (HTTP 429)';
        SafeLogger.warning(
          `Primary model "${config.model}" encountered ${errorLabel}. Attempting fallback model: "${fallbackTargetModel}" [attempt 2 of ${config.maxRequests}]...`
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
          const fbStartTime = Date.now();
          const fbResult = await fallbackProvider.review(reviewInput, fallbackAbortController.signal);
          clearTimeout(fallbackTimeout);
          SafeLogger.info(`AI review response received from fallback model (${Date.now() - fbStartTime}ms).`);
          rawFindings = fbResult.findings;
          aiSummary = fbResult.summary;
          if (fbResult.usage?.inputTokens) {
            inputTokens = fbResult.usage.inputTokens;
            providerReportedUsage = true;
          }
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
              providerReportedUsage,
              upgradeNotice: config.upgradeNotice,
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

    if (providerReportedUsage) {
      SafeLogger.info(`Token usage (provider-reported): inputTokens=${inputTokens}, outputTokens=${outputTokens}`);
    } else {
      SafeLogger.info(`Token usage (conservative estimate): ~${inputTokens} inputTokens, ${outputTokens} outputTokens`);
    }
    SafeLogger.endGroup();

    // 6. Validation & Safeguards Section
    SafeLogger.startGroup('Validation & Safeguards');
    SafeLogger.info(`Received ${rawFindings.length} raw finding(s) from AI model.`);

    let staticFindings: Finding[] = [];
    if (config.staticReportPaths.length > 0) {
      SafeLogger.info(`Ingesting ${config.staticReportPaths.length} static report path(s)...`);
      const staticResult = ingestStaticReports({
        reportPaths: config.staticReportPaths,
        expectedHeadSha: prDetails.headSha,
        filePatchMap,
      });
      SafeLogger.info(`Ingested ${staticResult.findings.length} findings from ${staticResult.processedReports} report(s).`);
      if (staticResult.skippedReports.length) { status = 'partial'; reasonCode = 'static_reports_skipped'; }
      staticFindings = staticResult.findings;
    }

    const { validFindings, droppedFindings } = validateAndFilterFindings(rawFindings, { filePatchMap, minSeverity: config.minSeverity, requireEvidence: config.requireEvidence });
    const staticValidation = validateAndFilterFindings(staticFindings, { filePatchMap, minSeverity: config.minSeverity });
    validFindings.push(...staticValidation.validFindings);
    droppedFindings.push(...staticValidation.droppedFindings);

    SafeLogger.info(`Validation results: ${validFindings.length} valid finding(s), ${droppedFindings.length} dropped/filtered.`);

    if (droppedFindings.length > 0) {
      status = 'partial';
      reasonCode = 'invalid_findings_dropped';
      for (const d of droppedFindings) {
        SafeLogger.warning(`Dropped finding reason: ${d.reason}`);
      }
    }
    SafeLogger.endGroup();

    // 7. Publication & Telemetry Section
    SafeLogger.startGroup('Publication & Telemetry');
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
        providerReportedUsage,
        overview: aiSummary,
        fallbackFromModel,
        fallbackReason,
        incrementalSkipped,
        contextFiles: relatedContext.length,
        upgradeNotice: config.upgradeNotice,
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
    SafeLogger.info(`Published ${publishedCount} new inline finding comment(s) (deduped: ${publishResult.dedupedCount}).`);

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
    SafeLogger.endGroup();

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
