# Implementation review and remediation

**Reviewed:** 24 October 2026. **Scope:** source, action metadata, workflows, tests, bundled entry point and planning documentation in this local checkout.

## Assessment

The project contains a substantial POC, but the original README's claim that every milestone was completed was unsupported. The initial 54 deterministic tests passed; they did not prove live provider accuracy, GitHub publication behavior, cost, or release readiness. Gemini was the only real adapter. This review adds OpenAI, Anthropic Claude and Ollama and corrects several implementation defects.

This is a code and local-test review, not an exhaustive security audit or a production certification. No live credentials were used, no provider charges were incurred by testing, and no GitHub comments, releases or pull requests were published.

## Issues fixed

| Priority | Finding | Change |
| --- | --- | --- |
| High | Review workflow used `./` without checking out the action; placeholder lint reports did not run real checks | Checkout/build only the trusted default branch; remove pretend lint integration; configurable provider/model/key |
| High | Comment triggers lacked actor permission checks and accepted command prefixes | Require created comments and verified write/maintain/admin access; exact commands and exact file matching |
| High | Provider timeout only raced the SDK promise; original network work could continue | Shared native HTTP transport with abort signal; no automatic retries or redirects |
| High | Provider/GitHub error strings could contain source or arbitrary secrets | Do not emit raw transport bodies or exception messages |
| High | Failed batch writes retried every comment and could duplicate an already accepted write | Remove blind write fallback; mark ambiguous publication partial |
| High | Human comments could spoof dedupe/summary markers | Only trust the standard GitHub Actions bot's markers; custom token authors not supported |
| High | Request budgets counted only raw patches, omitting prompt/path/envelope size | Measure full serialized HTTP body during selection and again at send time |
| Medium | Patch parser ignored old-side counts and zero-count checks, mishandled trailing newlines | Reconcile both sides of every hunk and reject unknown prefixes |
| Medium | Same-response duplicate findings produced repeated inline comments | Track new fingerprints within the current batch |
| Medium | Inline publication errors and discarded findings could still yield completed/clean status | Propagate partial status and avoid a clean verdict after invalid findings |
| Medium | Model summary bypassed the finding text sanitizer | Sanitize generated summary before rendering |
| Medium | Static SHA checks were optional and suffix matching could select an unrelated file | Require a matching SHA wrapper, exact path mapping, bounded records and regular files |
| Medium | Brakeman confidence was treated as vulnerability severity | Use conservative medium pending rule-specific severity mapping |
| Medium | Absolute/traversal paths could be normalized into repository paths | Reject absolute paths, drive prefixes, controls and traversal |
| Medium | Incomplete comment/file pagination could silently lose state | Skip incomplete file inventories; fail comment reads at pagination ceiling |
| Medium | Numeric inputs silently accepted text such as `10junk` | Reject malformed integer strings |
| Medium | CI bundle check printed status without failing on drift | Fail when generated bundle differs from tracked artifact |
| Documentation | Unverified release/model examples and completed-milestone claims | Explicit model variable and commit placeholder; distinguish tests from live evidence |

## Added provider support

`gemini`, `openai`, `anthropic` and `ollama` share bounded transport and common response validation. Cloud providers require explicit external opt-in and the selected provider's key. Ollama supports loopback and explicitly opted-in HTTPS remote origins. See [PROVIDERS.md](PROVIDERS.md) for setup, limits, caveats and official API sources.

## Remaining issues and release work

| Priority | Outstanding work | Release implication |
| --- | --- | --- |
| High | Verify live end-to-end GitHub comments, model contracts and the labeled corpus for each enabled provider | Do not mark M6 or the release gates complete from mock tests |
| High | Static wrapper SHA is self-reported; automated producing workflow/run provenance verification is not implemented | Only ingest reports from an integration that independently verifies origin; optional static integration is not production-ready |
| Medium | Unified patch reconciliation does not compare all added/deleted totals against GitHub file metadata | A structurally valid omitted hunk can understate coverage; add metadata reconciliation fixtures |
| Medium | Skip/provider-failure paths return outputs without updating the maintained PR summary | Old summaries can remain visible; add a centralized finalizer with runner-summary fallback |
| Medium | Provider timeout is 60 seconds and GitHub requests 15 seconds each; strict 120-second whole-action cancellation is not implemented | Included job has a three-minute ceiling; PRD deadline remains unmet |
| Medium | Ambiguous writes are not immediately reconciled; inline counts may be unknown, and failure fetching summary history after a write can lose the reported count | Partial status is safer than duplicate writes; implement marker-based reconciliation for reliable accounting |
| Medium | Guard now disables generated Markdown links/images and screens common injections; semantic off-task detection remains heuristic | See [AI guard](AI_GUARD.md); run live adversarial evaluation and treat recommendations as untrusted |
| Medium | Dedupe depends on wording and line location, standard bot identity, and workflow serialization | Reworded/moved findings or independent workflows can still duplicate feedback |
| Medium | Third-party workflow actions remain on version tags; runtime and dependency audit are outstanding | Pin reviewed SHAs and verify supported runtime/dependency policy before distribution |
| Low | File-list collection can scan up to 1,000 files before review budgeting; optional reports cap at 20 | Further bound collection resources and clearly report all coverage limits |
| Low | Unknown static formats can yield no findings; rule-specific severity mapping remains basic | Add explicit format diagnostics and more representative tool output fixtures |

## Verification record

**Result: 86 tests passed across 12 test files; `npm run build` passed (TypeScript check and bundle generation); `git diff --check` passed.** The tracked bundle was regenerated. HTTP tests are mocked and use no real API credentials. Regression tests cover malformed diffs, duplicate findings, human summary markers, permission gates, partial publication and cloud opt-in. Provider tests cover all four request envelopes, usage parsing, one-call quota failure, invalid responses, pre-send budgets, cancellation, response-size limits and remote Ollama restrictions.

**Live validation:** not performed. **Company pilot approval:** not granted by this review. **Commit/push/release:** not performed.

## Recommended next iteration

1. Finish centralized status reporting, exact whole-run deadline and static artifact provenance checks.
2. Add GitHub metadata reconciliation, safe rendering and ambiguous-write reconciliation.
3. Pin release dependencies/actions and verify runtime support.
4. Run and record the personal synthetic evaluation corpus with the selected provider under configured account limits.
5. Prepare the measured company demo only after those results are reviewed.

## Follow-up: review-only guard

Added mandatory scope instructions, JSON-encoded untrusted input, injection tripwires, strict output fields, tool-call rejection and safer rendering across all four providers. See [AI_GUARD.md](AI_GUARD.md) for behavior, tests and limitations.
