# Project TODO

Updated: 2026-10-25

## Objective

Prepare a CodeRabbit-style installation and centrally managed update experience,
while keeping PR reviews low-cost, bounded, and comment-only. Improve the existing
Action's logs, review comments, and plain-language suggestions.

## Current state

- Released GitHub Action: `v0.2.15` (tested and bundled in `dist/index.js`).
- Implemented: file-patch incremental review, bounded JS/TS import context,
  exact-line evidence checks, severity filtering, and review-only guards.
- Conversational inline review thread replies: answers developer questions on inline code
  review comments (`pull_request_review_comment` event, e.g. `/review why is this needed?`, `/ask ...`).
- Clearer Actions logs: collapsible groups for each stage, detailed file/exclusion/token counts,
  deterministic outcome explanations, workflow-command injection protection.
- Enhanced PR comments: Issue & Impact, Recommended Action, optional Verification suggestion,
  accurate scoped clean verdicts, provider-neutral failure guidance.
- Plain-language suggestions: "suggestion no code" policy enforced, executable code fences stripped.
- Defaults: one model request, 12,000 estimated input tokens, 2,000 output tokens,
  and five findings per run.
- Hosted GitHub App architecture, security model, and rollout strategy documented
  in `docs/GITHUB_APP_ROLLOUT.md`.

## 1. Documentation and delivery design — first priority

- [x] Create this TODO before implementation.
- [x] Add a GitHub App architecture and rollout document, clearly distinguishing
  proposed functionality from the working Action.
- [x] Explain the client experience: install the App, select repositories, configure
  preferences, then receive reviews without adding an Actions workflow.
- [x] Document the hosted flow: GitHub webhook → signature validation → durable
  queue → bounded review worker → validated GitHub comments.
- [x] Define repository permissions, installation-token lifecycle, tenant isolation,
  quotas, secret storage, retention, uninstall cleanup, and hosting responsibilities.
- [x] Explain central updates, compatible configuration defaults, staged rollout,
  rollback, and permission changes that require client approval.
- [x] Document the lower-cost Action alternative: a maintained moving release tag
  for compatible updates, versus full-SHA pins for explicitly reviewed updates.
- [x] Refresh README setup instructions and link the architecture, security,
  low-cost settings, and rollout documents.
- [x] Provide a client workflow example supporting both automatic PR reviews and
  authorized `/review` commands, without executing untrusted PR code.

Acceptance: a reader can distinguish what works today, what needs hosting, and
whether a new release requires changes in client repositories.

## 2. Clearer GitHub Actions logs — next implementation

- [x] Add collapsible log sections for setup, security checks, file selection,
  budget/context selection, provider execution, validation, and publication.
- [x] Show useful counts: reviewed files, unchanged files, exclusions by reason,
  included context files, valid findings, filtered findings, and duplicates.
- [x] Show configured limits, request attempts, elapsed time, and available token
  usage. Distinguish conservative estimates from provider-reported usage.
- [x] Give every outcome a concise explanation and next step, including skips,
  quota failures, invalid output, and incomplete publication.
- [x] Preserve secret masking; never log source, prompts, evidence quotes, raw
  provider responses, API keys, or unsafe workflow-command strings.
- [x] Keep presentation deterministic; do not spend extra model calls on logs.

Acceptance: clients can understand what happened and why without reading raw
source or exposing sensitive data in workflow logs.

## 3. More useful PR review comments

- [x] Improve inline findings with a clear issue/impact explanation and a concise
  recommended action; add a short verification suggestion where justified.
- [x] Keep the summary compact: result, scope, severity counts, new/duplicate
  findings, exclusions, context, and token usage in collapsible details.
- [x] Avoid labeling the whole PR “clean” when only selected changes were reviewed
  or when an incremental run does not reassess earlier findings.
- [x] Replace provider-specific failure messages and unsupported quota claims
  with accurate, provider-neutral guidance.
- [x] Sanitize all rendered text, including paths and configuration labels;
  preserve deduplication and checkpoint markers.
- [x] Retain exact-path, exact-added-line, evidence, stale-head, and comment-only
  validation. Do not auto-resolve earlier findings without verification.

Acceptance: comments explain the supported problem and useful next action,
without overstating coverage or producing repeated noise.

## 4. Plain-language AI suggestions

Interpret “suggestion no code” as explaining how to address a supported finding
in words, without generating replacement code or applying a patch.

- [x] Update the prompt to request concise, plain-language remediation and a
  practical verification step, grounded in the supplied code.
- [x] Keep suggestions attached to supported findings rather than adding generic
  improvement lists or unrelated advice.
- [x] Bound and validate any new response fields; reject unsafe/off-task output.
- [x] Do not publish executable snippets, GitHub suggestion patches, or tool calls
  as this feature. No automatic edits, pushes, approvals, or merges.
- [x] Keep the existing request and token caps; avoid a second model pass merely
  to expand or polish comments.
- [x] Document that evidence matching and prompt guards cannot prove a finding
  is correct or eliminate every prompt-injection attempt.

Acceptance: suggestions help a maintainer decide what to change and check,
while keeping the reviewer advisory and low-cost.

## 5. Verification and release

- [x] Test log masking and workflow-command injection resistance.
- [x] Test comment formatting, hostile paths/text, partial coverage, duplicate-only
  reviews, token labels, and provider-neutral failure guidance.
- [x] Test new suggestion fields, bounds, off-task responses, and request budgets.
- [x] Run the full test suite, type checking, and rebuild `dist/index.js`.
- [x] Update documentation to match implemented behavior and remaining limitations.
- [x] Prepare the release version and notes; publish when requested.

## 6. Hosted GitHub App — later implementation phase

This phase requires a chosen hosting account and GitHub App registration. The
documentation work above does not create or deploy a hosted service.

- [ ] Separate the reusable review engine from Actions inputs, outputs, and
  `github.context`; pass explicit installation/repository/event data instead.
- [ ] Replace hard-coded Actions-bot identity assumptions with verified App identity.
- [ ] Implement signed webhook handling, delivery deduplication, authorization,
  queueing, and per-PR concurrency control.
- [ ] Use repository-scoped installation tokens and isolate each installation's
  configuration, credentials, budgets, and review state.
- [ ] Recheck repository access and PR head before publishing; stop work after
  installation removal or access revocation.
- [ ] Add durable checkpoints, retry-safe publication, usage ceilings, and controls
  to prevent duplicated reviews or charges during webhook redelivery.
- [ ] Add minimal settings/onboarding, explicit source-sharing consent, and data
  retention/deletion controls before supporting external customers.
- [ ] Pilot on a controlled repository; verify uninstall, rollback, quota limits,
  delivery retries, isolation, and error recovery before expanding access.

## References

- [CodeRabbit setup](https://docs.coderabbit.ai/getting-started/quickstart)
- [CodeRabbit configuration](https://docs.coderabbit.ai/guides/configuration-overview)
- [GitHub App installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [Webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Action release management](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/manage-custom-actions)
- [Actions log groups and job summaries](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands)
