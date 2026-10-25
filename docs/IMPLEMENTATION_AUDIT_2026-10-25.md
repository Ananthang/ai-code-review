# Implementation audit — 25 October 2026

## Result

The Action has substantial working functionality, but the implementation is not
complete or ready to describe as fully guarded. The newest inline-thread reply
path has important security and functional gaps. Several TODO items are marked
complete more broadly than the code supports.

**This is an audit only. No application code, workflows, existing documentation,
release tags, or configuration were changed.** This report is the only repository
addition made during the audit. Recommended fixes below have not been applied.

## Reviewed snapshot and verification

- Commit: `73d9088937fc66b17f60fedc52f49a4c50b56c06`, package version `0.2.15`.
- Local `v1` and `v0.2.15` both resolve to that commit. Earlier reports that `v1`
  remained on an older release no longer describe this checkout. Remote tags
  and live deployment status were not independently checked in this audit.
- Reviewed orchestration, GitHub client/publication, all provider transport paths,
  configuration, budgets, context/checkpoints, validation, security guards,
  static-report ingestion, telemetry, workflows, tests, README and planning docs.
- Existing suite: **192 tests passed across 16 files**.
- Type checking: **passed**.
- Independently rebuilt the entry point into `/tmp`; it is byte-for-byte equal
  to tracked `dist/index.js`. The tracked bundle was not overwritten.
- Additional local reproductions used synthetic input, a mocked GitHub client,
  and a fake provider. The real HTTP adapter's request serialization was also
  inspected without sending a network request.
- No live model calls, provider charges, GitHub writes, or hosted-service tests.
  Passing mock tests does not establish model accuracy or production security.

## Findings requiring fixes

Priority: **P1 = address before relying on the affected feature; P2 = important
correctness, security-hardening or requirements gap.** Locations refer to this snapshot.

### F01 — P1: Inline discussion bypasses mandatory file exclusions

**Location:** `src/index.ts:288–331`; compare normal exclusion flow at `371–440`.

The thread path sends the event's `threadPath` and `diffHunk` directly to the
provider before constructing or using `PathExclusionFilter`. An authorized
`/ask` on a `.env`, private-key, generated, or user-excluded file bypasses the
path policy used by ordinary reviews. Credential regexes still run inside the
HTTP prompt builder, but they cannot recognize every arbitrary password/value.

**Reproduced:** a synthetic `.env` hunk reached the fake provider. The real Gemini
request serializer also accepted that path and a synthetic generic password.
No content was sent to an external service during the reproduction.

**Recommended fix:** route thread input through the same mandatory path, content,
per-file-size and context checks before provider access. Retain the existing
total serialized HTTP budget; it is still enforced today.

### F02 — P1: Replies to existing review discussions use the wrong comment ID

**Location:** `src/index.ts:351–352`; `src/github/client.ts:452–459`.

For a developer reply, the event comment ID identifies that reply, while
`inReplyToId` identifies the discussion's root. The Action sends the developer
reply's ID to GitHub's create-reply endpoint. GitHub requires a top-level comment
ID and does not support replies to replies.

**Reproduced:** with root ID `11` and developer reply ID `22`, publication was
called with `22`. The mock accepts it; the real API contract does not.

**Recommended fix:** resolve/validate the root comment and publish against it.
Add an API-contract regression test for the normal “reply to bot finding” journey.

[GitHub reply endpoint contract](https://docs.github.com/en/rest/pulls/comments#create-a-reply-for-a-review-comment).

### F03 — P2: Log command protection misses accepted command forms

**Location:** `src/telemetry.ts:39–43`; thread-path logging at `src/index.ts:292`.

The sanitizer neutralizes `::` only at the very beginning of a line. GitHub's
runner trims leading whitespace before parsing modern commands and also has
a legacy `##[...]` parser. Neither form is fully covered by this sanitizer.
Thread paths are logged before path screening, providing an untrusted-data route.

**Reproduced:** `prefix\n  ::error::synthetic` and `src/##[error]synthetic.ts`
survive sanitization. Runner source confirms the relevant parsing behavior.
This can tamper with annotations/log handling; this audit does not claim shell
execution or credential theft from this finding.

**Recommended fix:** normalize untrusted log fields to safe single-line text and
neutralize all accepted command prefixes, including legacy syntax. Test actual
log output as well as direct sanitizer calls.

[GitHub runner command parser](https://github.com/actions/runner/blob/main/src/Runner.Common/ActionCommand.cs).

### F04 — P2: Thread answers have no stale-head or duplicate-publication guard

**Location:** `src/index.ts:288–368`.

Ordinary reviews recheck the PR head and deduplicate findings. Thread answers
bypass that pipeline. A reply can be generated from an old event hunk and posted
after a new commit; rerunning the same successful event can post another answer
and spend another request. Historical discussion can be useful, but the response
does not identify that it is answering obsolete source.

**Reproduced:** a mock reporting a different current head received zero
`getHeadSha` calls before thread publication.

**Recommended fix:** bind the answer to its source revision, label or reject stale
context explicitly, and deduplicate by triggering comment ID plus revision/policy.

### F05 — P2: Empty AI answers become invented successful replies

**Location:** `src/index.ts:342–365`.

A valid provider response containing no summary is replaced with generic advice
about production hygiene and says the developer may keep the pattern. The Action
then reports success. This is not an explanation supported by the model or code.
The optional client method also permits reporting publication success when no
reply method exists, although the production client currently implements it.

**Reproduced:** an empty summary produced the stock “feel free to keep it” answer
and a `completed` outcome.

**Recommended fix:** require a nonempty, valid thread explanation and confirmed
publication; report incomplete output rather than fabricating remediation advice.

### F06 — P2: “No-code suggestions” still publish the enclosed code

**Location:** `src/review/validate.ts:29–34, 115–123`.

`stripExecutableCodeBlocks` replaces fenced blocks with their captured contents.
It removes the formatting, not the replacement code. Verification and summary
fields do not pass through this function either. Plain-language-only behavior
is therefore prompted but not enforced as claimed in TODO.

**Reproduced:** a fenced suggestion containing `runDangerousOperation();`
returns `runDangerousOperation();`. It remains comment text, not executed code,
but violates the requested no-code output behavior.

**Recommended fix:** reject code-bearing responses or omit whole fenced blocks
and revalidate nonempty prose. Do not claim that arbitrary unfenced code can be
perfectly identified through a small regex.

### F07 — P2: Published client workflow cannot auto-load repository rule files

**Location:** `README.md:20–72`; `src/config.ts:99–177`;
`docs/GITHUB_APP_ROLLOUT.md` client template.

The consumer workflow runs the remote Action without checking out the client
repository. Instruction discovery only reads local workspace files. Consequently
`.github/ai-review.md` and path-based custom instructions are not loaded by this
template. A missing explicit file can even be treated as literal instruction text.
Fetching the Action repository is not a checkout of the client's repository.

**Recommended fix:** fetch rules from a trusted base/default-branch revision via
the GitHub API, or document an optional trusted checkout with credentials disabled.
Never solve this by building/executing the PR head in the privileged review job.

### F08 — P2: Invalid model paths can leak arbitrary model/source text into logs

**Location:** `src/review/validate.ts:90–103`; `src/index.ts:756–759`.

The model-controlled `path` field is interpolated into rejection messages and
logged. That field is not constrained to actual file paths before the message
is built. The model can put copied source or an unrecognized credential there;
known-key masking is not a general source-redaction mechanism.

**Reproduced:** a synthetic source sentinel in an invalid model path appears
unchanged in the dropped-finding reason consumed by the logger.

**Recommended fix:** log fixed rejection reason codes and counts, not raw invalid
fields or schema messages that may echo untrusted values.

### F09 — P2: The whole-run time budget remains unimplemented

**Location:** `src/index.ts:576, 636`; `src/review/context.ts`;
`.github/workflows/review.yml:25`.

Each ordinary primary/fallback model attempt can run for 120 seconds. GitHub
pagination, related-context reads, setup/build and publication add further time.
There is no shared 120-second deadline from the PRD. The example workflow's
three-minute job ceiling can kill a slow fallback before status publication.

**Recommended fix:** use a common deadline with remaining-time propagation and
reserve time for safe publication/status reporting. Align the workflow deadline
and documented timing contract. This was not a live timeout experiment.

### F10 — P2: Malformed targeted commands can broaden to a full review

**Location:** `src/github/client.ts:150–155`; `src/index.ts:198–202`.

The trigger accepts arbitrary text after `/review`, but a target is parsed only
when there are exactly two whitespace-separated words. `/review src/a.ts extra`
is therefore accepted without a target and initiates a full bounded PR review.
It can spend more tokens and review more source than the user intended.

**Recommended fix:** define a strict command grammar, reject extra arguments,
and explicitly support or reject filenames containing spaces.

## Other incomplete behavior and acceptance gaps

| Area | What exists | What is still missing or limited |
| --- | --- | --- |
| Hosted GitHub App | Architecture/rollout document | No registered/deployed App service, webhook ingress, durable queue, installation authentication, tenant store, dashboard or deployment/rollback implementation in this repository |
| Central updates | Local `v1` points at current code | No release automation in `.github/workflows`; SHA-pinned clients still require updates. `upgrade-notice` is supplied by client configuration/environment, not remotely discovered release information |
| Test coverage | 192 passing tests, provider mocks, formatting/security tests | No tests referencing thread events, `threadContext`, or `replyToReviewComment` were found; the newest end-to-end feature is untested by the committed suite |
| Detailed logs | Groups, totals, estimated/reported usage labels | Low-severity findings are silently skipped and not counted in the reported “dropped/filtered” total; not every configured limit or budget-exclusion breakdown is logged |
| Review summaries | Improved layout and scoped verdict | Severity totals are not implemented despite the TODO checkbox. Routine skipped/configuration-error outcomes do not consistently refresh PR/job summaries |
| Publication accounting | No blind retry of uncertain review writes | Summary-history fetch occurs after inline writes. Its failure can return zero published findings despite successful comments; ambiguous writes lack immediate reconciliation |
| Thread budgets and context | One request, output and total-request caps | Normal per-file-size/exclusion selection is bypassed; parent comment ownership and current-source consistency are not validated |
| Diff completeness | Hunk old/new counts checked | Parsed totals are not reconciled against GitHub file addition/deletion metadata; structurally valid omitted hunks may go undetected |
| Incremental reviews | Successful file-patch reuse | Not commit-range or full dependency analysis; changes to unselected dependencies may not invalidate an unchanged file's checkpoint |
| Related source | At most two bounded JS/TS relative imports | No test discovery, Ruby/Python import graphs, aliases, package resolution or repository-wide context |
| Static analysis | SHA-wrapped report ingestion | SHA is self-reported; workflow/run provenance is not verified by the Action. Unknown formats can be treated as empty results |
| Operational safety | Permission checks inside Action | Workflow-level PR concurrency is shared by comment events before in-Action authorization; assess cancellation behavior so unauthorized/irrelevant events cannot interrupt a useful review |
| Evidence of quality/cost | Synthetic evaluation fixtures | No new live provider accuracy, real billing, adversarial quality, or customer-pilot evidence was established by this audit |

## Documentation that needs correction

1. Reopen the over-broad TODO completion claims for no-code enforcement,
   filtered/severity counts, complete log protection and feature test coverage.
2. Update the older implementation review and PRD default/timeout/fallback tables
   to distinguish historical decisions from actual `0.2.15` behavior.
3. The hosted rollout document is labeled proposed, but contains categorical
   claims about zero retention, enterprise provider agreements, complete update
   visibility and rollback guarantees. These are deployment requirements to
   verify, not capabilities established by the current adapters or repository.
4. Clarify that the upgrade banner does not automatically notify an old pinned
   client about a new release. A release feed/update mechanism or dependency-update
   integration would be additional work.
5. Explain the trusted-checkout/API requirement for repository rule files in the
   client workflow example.
6. Align advertised slash commands with workflow filters: the engine recognizes
   more aliases and reply forms than the supplied workflow dispatches.

## Local reproduction record

The temporary harness imported production functions; it did not alter them.
Synthetic observations:

```text
Excluded .env thread input reached provider: true
Real HTTP request serializer accepted excluded thread path: true
Root comment ID: 11; publication called with reply ID: 22
Head rechecks during thread answer: 0
Empty summary published generic fallback prose: true
No-code filter output for fenced suggestion: runDangerousOperation();
Invalid model path copied into logged rejection reason: true
Indented modern workflow command survives sanitization: true
Legacy workflow command survives sanitization: true
```

The fake publication method deliberately records calls instead of rejecting the
wrong ID; GitHub's documented contract supplies the production failure evidence.
No exploit was run against a GitHub runner or external provider.

## Recommended order — awaiting a separate fix request

1. Fix thread file-exclusion enforcement and root-comment publication.
2. Add thread integration tests covering forbidden paths, correct roots, stale
   source, empty outputs, reruns and publication failures.
3. Harden log handling and remove raw rejected model fields from logs.
4. Correct no-code handling, command parsing and client instruction loading.
5. Align duration/status accounting, detailed counts and documentation claims.
6. Keep the hosted App as a separate implementation phase with explicit hosting,
   security, privacy and operational acceptance gates.

No commits, pushes, releases or fixes were performed for this audit.
