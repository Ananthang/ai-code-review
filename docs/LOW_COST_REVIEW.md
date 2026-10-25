# Low-cost PR review and security design

## Scope

Implemented: file-level incremental review, bounded related-source context, and evidence/severity filtering.
The Action remains advisory and comment-only. It never executes PR code, applies fixes,
pushes commits, approves a PR, or merges it. There are no model tools or autonomous loops.

## Configuration

Use these inputs on your existing Action step. Provider defaults to Gemini; explicitly
select a model available to your account. Keep the workflow and Action version trusted.

```yaml
with:
  provider: ${{ vars.AI_PROVIDER || 'gemini' }}
  model: ${{ vars.AI_MODEL }}
  provider-api-key: ${{ secrets.GEMINI_API_KEY }}
  allow-external-provider: true
  incremental: true
  max-input-tokens: 12000
  max-output-tokens: 2000
  max-requests: 1
  max-findings: 5
  thinking-level: low
  max-context-bytes: 2048
  min-severity: medium
  require-evidence: true
```

When choosing another provider, supply its matching API key. `allow-external-provider`
consents to sending selected patches, custom instructions and selected related source.
Use `max-context-bytes: 0` to disable extra source sharing. Use `incremental: false`
to review all eligible patches on every run. `/review` and `/review path/to/file.ts`
always force a fresh review within configured limits.

Input estimation conservatively counts one token per serialized UTF-8 byte, including
system instructions and provider envelope. It is a safety estimate, not a billing
prediction. Model reasoning charges and tokenizer behavior vary. Lower output caps can
produce incomplete responses; those are rejected rather than published as clean reviews.
A configured fallback does not activate a second request unless `max-requests: 2` is set.
The existing fallback handles capacity responses (429/503) and makes at most one extra call.

## Incremental behavior

Successful summaries store SHA-256 hashes of reviewed file patches and review settings.
Only checkpoints authored by `github-actions[bot]` are accepted. Human copies are ignored.
The hashes bind path, status, old path, and patch; the policy key binds base SHA, model,
settings, instructions and collected related context. Credentials are excluded from the
policy key. Missing, malformed, mismatched or unavailable state causes a bounded fresh review.
Up to 100 patch hashes are retained; eviction means a file can be reviewed again.

Only selected files are checkpointed. Budget-skipped files remain eligible on the next
run. Provider/validation failures, uncertain publication, stale heads and failed summary
writes cannot establish a new successful checkpoint. If every eligible patch is already
reviewed, the Action returns `skipped` / `unchanged_since_review`, without another model
call or summary update. It leaves earlier findings intact. Static-report runs bypass reuse.

This is **file-patch reuse**, not commit-range hunk review or semantic dependency analysis.
A changed file is reviewed using its full current PR patch. Changing an unselected dependency
may affect an unchanged file without invalidating that file's checkpoint. Use a manual full
review for cross-file refactors or final review. Other workflows with the same Actions bot
identity are within the trust boundary; bot author checking is not a cryptographic signature.

## Related context

The selector recognizes static relative imports in JavaScript/TypeScript patches. It tries
at most four candidate paths and includes at most two whole source files, within the total
context byte cap (default 2 KiB, maximum 8 KiB). Extensionless imports try `.ts` then `.js`.
It does not resolve packages, aliases, dynamic imports, repository indexes or arbitrary links.
It does not yet discover tests or analyze other languages' import graphs.

Source is fetched through Git trees/blobs at the immutable PR head SHA. Paths have at most
eight components; traversal, symlinks, submodules, oversized blobs and truncated trees are
rejected. No local PR checkout is needed for this source. This entails bounded GitHub API
reads, not extra model calls. Unavailable, excluded, binary, secret-marked or injection-marked
context is omitted. The existing mandatory exclusions and user exclusions apply equally.

Diff selection happens first. Context is added only when the fully serialized request still
fits both input limits. It cannot displace a diff file to consume its budget. Related files
are supporting evidence only: inline findings must target exact added lines in reviewed patches.

## Evidence and noise controls

The prompt asks for concrete bugs/security defects, their triggering conditions and impact.
Generic style, cleanup and logging advice without demonstrated impact is excluded.
`min-severity` accepts `critical`, `high`, `medium` or `low`; lower-severity results are quietly
filtered. At most five findings are published by default.

With `require-evidence: true`, model findings must include `evidence`: an exact nonempty
source line at their claimed added line, without the patch's `+` prefix. Fabricated evidence,
nearby-line guesses, abbreviated paths and case-insensitive path guesses are rejected.
Invalid findings produce a partial outcome and are not checkpointed. SHA-bound static
reports retain their separate schema/line validation and severity filter; they do not need
an AI-generated evidence quote.

A correct quote does not prove a bug, and model-assigned severity is not calibrated confidence.
These controls improve traceability; they cannot guarantee accurate reviews.

## Security boundaries

- Fork PRs, unsupported events and unauthorized comment triggers retain existing rejection rules.
- Diffs, file names, related context and custom instructions are untrusted data. They cannot
  authorize unrelated tasks, network destinations, tool use, secret disclosure or policy changes.
- Credential and prompt-injection screening applies before source is sent to a provider;
  output schema, unsafe-content checks, exact path/line checks and comment sanitization follow.
- Prompt-injection patterns and secret patterns are heuristics and can miss disguised content.
  The hard restriction is the absence of execution/tools and constrained comment publication.
- Use a trusted workflow/Action revision and a trusted checkout for local custom-instruction
  files or static reports. Do not run untrusted PR scripts with a write token or provider secrets.
- Retain `contents: read`, `pull-requests: write`, and the existing issue-comment/reaction permissions
  needed by your workflow. Never grant contents write for this reviewer.

## Verification

Tests cover checkpoint spoofing/invalidation, unchanged runs without model calls, manual
rechecks, failed publication, context budgets/exclusions, secret/injection screening,
symlink/submodule rejection, exact evidence/line/path validation and severity filtering.
Provider tests mock HTTP; no paid live-model review or real GitHub publication is part of validation.
