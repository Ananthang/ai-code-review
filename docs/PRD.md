# Product requirements — AI Code Review Action

**Version:** 0.2 · **Date:** 24 October 2026 · **Status:** Proposed, not implemented

**Product owner:** Project maintainer. **Delivery roles:** maintainer owns prioritization and approval; implementer owns engineering and tests; demo reviewer assesses finding usefulness. These are roles, not assigned people.

## 1. Product outcome

Help individual developers catch actionable issues in pull requests without running a hosted service or committing to an automatically expanding AI bill. Deliver a low-cost, open-source proof of concept with inline findings and a concise summary. Collect evidence before requesting a company pilot, with results available for the April 2027 ATL growth discussion.

The action supplements human review. It does not certify code security or correctness, approve changes, or serve as a merge gate.

## 2. Users and problems

| User | Need | Observable outcome |
| --- | --- | --- |
| Personal repository maintainer | Spot meaningful issues while reducing review effort | Useful comments on the correct changed lines |
| Contributor | Understand and act on feedback | Explanation, severity, and concrete recommendation |
| Future company evaluator | Assess value, confidentiality, and operating cost | Measured demo and documented limitations before approval |

Initial target codebases are Next.js/React, Ruby on Rails, and AWS Lambda applications. This describes intended evaluation coverage, not guaranteed framework-specific analysis.

## 3. Scope and priorities

**MVP / required:** reusable TypeScript action; same-repository PR events; GitHub API diff collection; exclusions and context limits; Gemini adapter; structured, validated findings; rerun deduplication; inline comments and one maintained summary; safe skips; bounded requests; sanitized telemetry; setup and security documentation.

**Conditional MVP:** ingest optional ESLint, RuboCop, Brakeman, and Checkov results when supplied by separately configured checks. Missing tools do not prevent AI review. The AI job must not install or execute contributor-controlled tooling with its secrets.

**After the MVP:** Ollama on a suitably connected runner, Claude/OpenAI adapters, richer context, additional static-result formats, and team evaluation. The shared provider interface is required now; working additional adapters are not.

**Excluded:** dashboard, database, hosted SaaS, autofix commits, auto-approval, merge blocking, full-repository analysis, guaranteed vulnerability detection, automatic paid fallback, and company-code processing before approval.

## 4. Primary journey

1. Maintainer installs a released action version, selects a model, provides credentials through secrets, and enables the required permissions.
2. An opened, synchronized, or reopened same-repository PR starts review. Fork and draft PRs are skipped for the initial release.
3. The action records the head commit, collects changed patches, applies exclusions, and checks configured limits and provider opt-in.
4. The action sends bounded context once to the selected provider; optional static findings join the same validation pipeline.
5. Valid, novel findings become inline comments. A maintained summary reports coverage, exclusions, findings, and review status.
6. A rerun suppresses already published findings. A new commit receives review against its current diff.

## 5. Functional requirements

| ID | Requirement | Acceptance evidence |
| --- | --- | --- |
| FR-01 | Handle opened, synchronize, and reopened PR events; skip forks and drafts before provider access | Event fixtures prove no outbound provider request for skipped events |
| FR-02 | Paginate changed files and parse unified patches into added-line maps | Multi-page and multi-hunk fixtures; additions, renames, deletions, and missing patches |
| FR-03 | Exclude known secret paths, binaries, generated/vendor files, lockfiles, and unusable patches; support additional ignore patterns | Exclusion fixtures and count-only summary |
| FR-04 | Enforce file, patch, total-context, output, request, duration, and comment limits before relevant operations | Boundary and over-limit tests |
| FR-05 | Implement Gemini behind a provider-neutral contract; require an explicit model | Fake-provider integration test and controlled live demo |
| FR-06 | Require structured findings with path, added line, severity, explanation, and recommendation | Schema tests reject malformed or excess output |
| FR-07 | Publish only findings on included files and verified added lines; suppress duplicates and cap volume | Invalid-line, duplicate-rerun, and comment-cap tests |
| FR-08 | Maintain one bot-owned summary; publish review comments without approval or change-request events | API fixture and demonstration PR |
| FR-09 | Ingest supported optional static outputs as data; map findings to the current diff | Missing, stale, malformed, and valid-result tests |
| FR-10 | Safely skip when credentials, opt-in, permissions, or quota are unavailable; never automatically change provider or model | Failure matrix tests and clear status reporting |
| FR-11 | Log counts, status codes, duration, and estimated/actual usage when available; redact source and credentials | Captured-log tests using sentinel secrets and source strings |
| FR-12 | Recheck head SHA before publishing and discard stale results | Simulated head change while review is running |

## 6. Security and cost requirements

- Treat PR text, patches, file names, static reports, and model responses as untrusted data. The model cannot call tools or execute commands.
- Use a trusted, released action bundle. Do not check out, build, or execute the PR head inside the credential-bearing review job.
- Use least-privilege repository permissions and no `pull_request_target` execution of PR code. Same-repository contributors are still an input trust boundary.
- Deny known secret-file patterns and skip patches with high-confidence credential markers before sending context. Detection is defense in depth and cannot guarantee that a diff contains no secrets.
- Require explicit external-provider opt-in. Explain that selected diff content leaves GitHub for the provider; service terms and data handling must be verified before activation.
- Use one provider request per run initially, no automatic retry after an ambiguous failure, no fallback, and a required output cap. Local usage limits bound exposure but cannot guarantee free usage or a monetary ceiling.
- Maintainers must verify provider billing/quota settings and runner allowances before enabling. A hard currency budget requires enforceable provider/account controls; the action cannot promise one from token estimates.
- Do not log patches, prompts, raw model responses, credentials, or raw error bodies. Published findings can contain limited source context visible to repository participants.

## 7. Proposed default limits

These are starting product decisions to validate during the demo, not measured optimal values.

| Setting | Default | Behavior |
| --- | --- | --- |
| Reviewed files | 20 | Deterministic selection; report exclusions |
| Patch size per file | 20 KiB UTF-8 | Skip oversized file; never cut a hunk arbitrarily |
| Total serialized input | 80 KiB UTF-8 | Include whole eligible patches within budget |
| Estimated input tokens | 24,000 | Additional conservative guard; not a billing guarantee |
| Provider requests | 1 per run | No automatic fallback or retry |
| Output tokens | 4,000 | Pass provider-enforced output limit |
| Inline findings | 10 per run | Rank by severity, then deterministic path/line order |
| Provider timeout | 60 seconds | Cancel and report incomplete review |
| Overall review deadline | 120 seconds | Stop further processing/publication safely |
| Review language | English | Configurable; file identifiers remain exact |

## 8. Release acceptance and measurement

Required release demonstrations:

- A seeded, unambiguous bug produces a useful finding on the intended changed line.
- A clean baseline receives no invented critical/high finding. Any observed severe false positive blocks the demo release until investigated.
- Identical reruns create no duplicate inline findings and update one summary.
- Invalid lines and excluded files receive no inline comments.
- Missing credentials, forks, stale heads, quota errors, and malformed responses are handled without secret leakage or an unhandled action failure.
- Captured logs contain neither sentinel credentials nor source snippets.
- Provider replacement with a test adapter requires no changes to orchestration logic.

Build a fixed initial evaluation set of at least 12 PR fixtures: six with labeled defects across the target stacks, four clean changes, and two adversarial/limit cases. Deterministic fixtures test correctness; live model runs measure quality and may vary. Record model/version, expected and observed findings, reviewer judgments, correct-line rate, duplicate count, precision, seeded-defect recall, duration, request count, tokens, and estimated cost with its assumptions. Never equate estimates with invoices or claim time savings without a measured comparison.

## 9. Decisions and open items

**Decided for planning:** Gemini first; Ollama deferred; same-repository non-draft PRs only; comment-only behavior; static report ingestion separated from secret-bearing review; no automatic retries; proposed MIT license for owner approval before release.

**Before implementation:** confirm personal GitHub repository and ownership, action packaging/runtime compatibility, and the selected test framework.

**Before live activation:** verify model availability and limits, provider SDK/API contract, current terms and billing controls, GitHub permissions/runner allowance, and supported static-result formats. No current pricing, free-tier entitlement, or SDK version is asserted by this document.

**Before company pilot:** obtain approval for code processing, provider data handling, repository access, budget ownership, and evaluation scope. Personal demo success alone is not approval.
