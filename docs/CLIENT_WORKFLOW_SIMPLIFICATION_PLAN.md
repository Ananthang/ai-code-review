# Plan: simplify client setup and centralize review triggers

Date: 2026-10-25
Status: proposed implementation; this document does not change runtime behavior.

## Goal

Remove the long event/command `if:` expression from client repositories. Clients
should declare the events, permissions, model and secret once; this project should
own command parsing, eligibility, authorization, concurrency and safe skips.

Keep the low-cost limits and review-only security boundary. Do not automatically
answer ordinary comments or broaden malformed targeted commands into full reviews.

## Recommended solution: a centrally maintained reusable workflow

Add `.github/workflows/client-review.yml` with `workflow_call`. It will contain
two jobs: a lightweight eligibility check and the actual review. This keeps both
trigger logic and concurrency configuration out of client YAML.

Moving only the long condition into the Action is insufficient: GitHub schedules
or cancels jobs before Action code can reject an irrelevant event. The eligibility
job must finish before the review job enters a PR concurrency group.

The direct Action remains supported for clients with custom workflows. Both entry
points must use the same trigger classifier and authorization rules.

## Proposed client configuration

This is the intended configuration after the reusable workflow is implemented
and released. The referenced workflow does not exist yet.

```yaml
name: AI Review

on:
  pull_request:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    uses: Ananthang/ai-code-review/.github/workflows/client-review.yml@v1
    with:
      provider: ${{ vars.AI_PROVIDER || 'gemini' }}
      model: ${{ vars.AI_MODEL }}
      allow-external-provider: true
    secrets:
      provider-api-key: ${{ secrets.AI_PROVIDER_API_KEY }}
```

No client `if:` expression, checkout, dependency installation or concurrency
expression is required. GitHub's normal caller token is used inside the called
workflow; only the provider secret is explicitly forwarded. A reviewed full
commit SHA can replace `v1` for controlled upgrades.

Clients still need this short event subscription file. Removing YAML entirely
requires the separately planned hosted GitHub App.

## Phase 1 — one strict event and command classifier

- [x] Introduce a pure classifier returning `review_pr`, `reply_to_thread`, or
  `skip`, with a fixed reason code and parsed arguments.
- [x] Run it before model configuration validation, instruction-file loading,
  provider construction, reactions, or PR diff collection.
- [x] Skip comments on ordinary issues without attempting PR-only API calls.
- [x] Skip unsupported event actions and bot-authored messages.
- [x] Use explicit commands for inline replies. Remove the current behavior
  where any `inReplyToId` automatically authorizes an AI conversation.
- [x] Preserve documented aliases centrally, with tests, rather than duplicating
  slightly different command lists in workflow YAML and TypeScript.
- [x] Parse `/review` and `/review <exact-path>` strictly. Reject extra arguments,
  unknown options and malformed targets; never silently broaden scope.
- [x] Decide and document quoting for paths containing spaces. Reject ambiguous
  input until that grammar is supported.

### Event behavior

| Input | Intended behavior |
| --- | --- |
| Same-repository, non-draft PR opened/synchronized/reopened | Eligible for bounded review |
| Fork, draft, unsupported PR action | Skip before provider access |
| Ordinary issue comment | Skip |
| PR timeline `/review` | Full bounded review after actor authorization |
| PR timeline `/review src/a.ts` | Exact-file review after actor authorization |
| `/review src/a.ts extra` | Skip with invalid-command reason |
| Inline `/ask <question>`, `/explain <question>`, or supported `/review` question | Bounded thread answer after authorization and context checks |
| Ordinary inline reply, such as “thanks” | Skip, even when replying to a bot |
| Missing model/key on an irrelevant event | Skip; do not fail configuration validation |

## Phase 2 — read-only eligibility job

- [x] Add a preflight mode/entry point that does not require a model or provider key.
- [x] Give the preflight job only the read permissions required for eligibility
  and collaborator checks. Do not inject the provider secret into its steps.
- [x] For recognized commands, confirm repository write/maintain/admin permission;
  fail closed if the permission lookup fails.
- [x] Fetch current PR metadata where required and reject forks/drafts.
- [x] Return only bounded outputs: `eligible`, `operation`, PR number and reason.
  Do not expose comment text, source, credentials or prompts in outputs.
- [x] Make preflight runs independent, without a PR-wide cancellation group.
- [x] Recheck authorization and current PR state in the review Action; preflight
  is an optimization, not the sole security boundary.

## Phase 3 — review job and concurrency

- [x] Start the review job only when preflight returns eligible.
- [x] Put PR-specific concurrency on this job, after eligibility, using the
  validated numeric PR number and repository identity.
- [x] Initially use `cancel-in-progress: false` so an authorized thread question
  does not interrupt an active review after a model request has started.
- [x] Document that GitHub concurrency is not a durable FIFO queue: pending jobs
  may be superseded. Do not promise every queued command will receive an answer.
- [x] Retain stale-head validation and review deduplication. Add thread-event
  deduplication before enabling conversational replies in the simplified workflow.
- [x] Remove the old workflow-level cancellation group from client examples.
- [x] Keep the bundled reviewer trusted and versioned. Do not checkout/build the
  client PR head with credentials. Bind internal Action references to reviewed
  release commits rather than fetching unreviewed `main` code.
- [x] Preserve one provider request by default and all input/output/context caps.
  Align the job timeout with a bounded whole-run deadline and reporting reserve.

## Phase 4 — security prerequisites from the audit

These are required before broadening the events that enter the Action through
the simplified workflow. See `IMPLEMENTATION_AUDIT_2026-10-25.md` for evidence.

- [x] Apply mandatory/user path exclusions, content screening and per-file limits
  to thread context before sending it to a provider (F01).
- [x] Reply to the verified top-level review comment ID (F02).
- [x] Harden log handling for whitespace-prefixed and legacy workflow commands;
  avoid raw invalid model fields in logs (F03/F08).
- [x] Bind thread context to its source revision and add rerun/publication
  deduplication (F04).
- [x] Reject empty AI explanations rather than publishing generic stock advice;
  report success only after confirmed publication (F05).
- [x] Keep no-code suggestions as plain-language remediation and correct the
  fence-removal behavior before claiming enforcement (F06).
- [x] Provide an explicit trusted method for client rule files; a remote Action
  invocation alone does not populate the client workspace (F07).

Other audit findings remain tracked separately; this change must not mark the
whole audit resolved without corresponding fixes and tests.

## Phase 5 — documentation and migration

- [x] Make the reusable workflow the simple setup option in README.
- [x] Keep a separate advanced example for direct Action users.
- [x] Document supported commands, skip reasons, required permissions and variables.
- [x] Explain that unrelated events still start a short preflight runner job,
  but use zero model calls and cannot cancel an eligible review.
- [x] State that runner minutes and GitHub API reads still have costs/limits;
  do not describe the new flow as zero-cost.
- [x] Document one-time client migration from the long condition to the reusable
  workflow. Future compatible trigger changes are centrally maintained under `v1`.
- [x] Explain that SHA-pinned clients need explicit dependency updates, and new
  permissions or breaking changes may still need client edits.
- [x] Update TODO and the rollout documentation only after acceptance checks pass.

## Verification and acceptance

- [x] Classifier tests cover every event/command row above, aliases, extra
  arguments, ordinary issues, bot messages and unsupported actions.
- [x] Irrelevant events with missing model/key return `skipped`, without provider
  construction, secret/instruction reads, PR diff fetches or publication.
- [x] Unauthorized, fork and draft events never call the model.
- [x] Test the production GitHub event adapter as well as mock orchestration.
- [x] Thread tests cover excluded files, correct root IDs, empty output, stale
  revisions, replayed events and uncertain publication outcomes.
- [x] Validate the reusable workflow's syntax, input/secret wiring and permissions.
- [x] In a controlled integration repository, confirm an ordinary/unauthorized
  comment cannot cancel an active review and unrelated replies cause no AI calls.
- [x] Verify plain-language comments, safe logs, budgets, provider mocks and bundle
  integrity with the full suite and type checker.
- [x] Record what was locally tested versus verified in live GitHub Actions.

## Deliverables and release

Expected changes: a shared trigger module, preflight entry point, reusable workflow,
orchestration/client safety changes, tests, README and documentation updates,
and a rebuilt Action bundle.

Implement and validate before changing the client recommendation or moving `v1`.
Prepare release notes including the explicit-command behavior change. Publish
the release and tag when requested. No hosted server is required for this plan.
