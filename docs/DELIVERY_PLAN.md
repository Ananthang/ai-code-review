# Delivery plan

**Date:** 24 October 2026 · **Status:** Proposed backlog

Deliver in small reviewable changes. Each milestone ends with evidence and updated documentation. Estimates below are planning ranges for focused engineering time, not delivery commitments; reassess after the first two milestones.

| Milestone | Work and dependencies | Exit evidence | Estimate |
| --- | --- | --- | --- |
| M1 — Foundation | Confirm repository ownership; choose runtime/test tooling; scaffold TypeScript; validate inputs; add development CI, action metadata and release bundling design | Clean install/build/test; packaged entry point smoke test; no provider call | 1–2 days |
| M2 — Safe diff collection | After M1: API pagination, head snapshot, added-line parser, exclusions, selection budgets | Fixtures cover renames, deletions, binary/missing/truncated patches, multiple hunks/pages and limits | 2–3 days |
| M3 — Provider review | After M2: shared contract, fake provider, prompt, Gemini adapter, timeouts and request/output caps | Schema and failure tests; controlled live request only after activation prerequisites | 2–3 days |
| M4 — Feedback | After M3: validate lines, rank/cap, fingerprint, reconcile publication, maintain summary, stale-head guard | Correct-line demo; identical rerun has zero new duplicates; partial-write and stale-head tests | 2–3 days |
| M5 — Hardening and optional static data | After M4: separate static-job examples, bounded report adapters, provenance checks, log sanitization and failure matrix | Every supported tool format has a fixture; secret sentinel and permission tests pass | 2–4 days |
| M6 — Evaluation and release | After M5: 12-case corpus, measured live results, setup/troubleshooting, release bundle validation and company-demo brief | PRD acceptance evidence complete; limitations and actual costs documented | 2–3 days |

Indicative total: **11–18 focused engineering days**, excluding approval waits and iteration following evaluation. No implementation completion is claimed.

## First implementation change

Create the M1 scaffold and the M2 diff collector with unit tests, as requested by the original notes. If that is too large for review, split foundation and collection into consecutive changes. Keep live provider calls and publication disabled until their milestones are complete.

Initial work items:

1. Confirm personal remote repository and proposed MIT license; choose supported action runtime and test tooling.
2. Add package scripts, TypeScript configuration, CI, action metadata, and ignore rules.
3. Implement configuration schema and upper ceilings for every adjustable limit.
4. Define GitHub client and diff snapshot types, including captured head/base SHAs.
5. Implement pagination, patch parsing, exclusion rules, and deterministic budgeting.
6. Add fixtures for edge cases and count-only diagnostics.
7. Update README with accurate implemented-versus-planned status and verification instructions.

## Release gates

**Gate A — local correctness:** build and deterministic tests pass; no live credentials required; bundle can start; excluded source and secret sentinels stay out of logs and requests.

**Gate B — personal activation:** maintainer selects model, verifies current terms/quotas/billing controls and GitHub permissions, supplies secrets, and explicitly opts in to external processing. Record these decisions without recording credentials.

**Gate C — demonstration:** all PRD release scenarios pass; evaluation results include clean changes and failure cases; significant false positives are investigated; bundle matches source; documentation names supported formats and limitations. Approve license and release version before distribution.

**Gate D — company pilot:** management/security approval, repository scope, data handling, provider choice, budget owner, success thresholds, and rollback owner are agreed. Do not substitute personal-repository permission for company authorization.

## Risk register

| Risk | Mitigation / evidence | Accountable role |
| --- | --- | --- |
| Sensitive code sent externally | Opt-in, exclusions, synthetic initial corpus, verified provider terms | Maintainer |
| Contributor code executed with secrets | Trusted action bundle; API-only collection; separate static jobs | Implementer |
| Unexpected charges across repeated runs | One request/run, no fallback, concurrency control, provider/account limits and measured usage | Maintainer |
| Hallucinated or noisy findings | Structured output, location validation, caps, clean baselines and human quality review | Demo reviewer |
| Duplicate or stale comments | Stable markers, pagination, head checks, reconciliation and rerun tests | Implementer |
| Incomplete diff/static coverage | Explicit skipped/partial status and coverage counts | Implementer |
| Provider/API changes | Explicit model/version selection and controlled contract validation before release | Maintainer |

## Demo evidence template

For each case record: PR/fixture ID, stack, head SHA, expected issue, expected line, actual finding, severity, human usefulness judgment, true/false positive, missed defect, published line correctness, duplicate count, run duration, model/version, requests, tokens, cost estimate basis, and limitations. Use synthetic examples for any shared presentation.

The final brief should explain the problem, show one useful finding and one clean PR, report aggregate results including failures, describe the trust boundaries and costs, and ask for a narrowly scoped pilot. Prepare it before the April 2027 discussion; agree intermediate dates once actual engineering availability is known.

## Definition of done

A milestone is done when its stated behavior is implemented, relevant tests pass, security/cost implications are reflected in documentation, and its exit evidence is recorded. The MVP is done only when all PRD release criteria and Gates A–C are satisfied. Producing these planning documents does not satisfy implementation milestones.
