# AI Code Review Action

A TypeScript GitHub Action for bounded, advisory pull-request feedback. Supports Gemini, OpenAI, Anthropic Claude, and Ollama through a shared HTTP transport, plus a deterministic fake provider for tests.

**Status: implemented POC, locally tested; not yet live-certified or production-ready.** Passing deterministic tests is not evidence of model accuracy, actual cost, or completion of the company-pilot gates.

- [Code-review-only AI guard](docs/AI_GUARD.md)
- [Low-cost review and security design](docs/LOW_COST_REVIEW.md)
- [GitHub App architecture and rollout plan](docs/GITHUB_APP_ROLLOUT.md)
- [Provider setup and behavior](docs/PROVIDERS.md)
- [Implementation review and remaining issues](docs/IMPLEMENTATION_REVIEW.md)
- [Product requirements](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Delivery plan](docs/DELIVERY_PLAN.md)

## Setup

For this repository, `.github/workflows/review.yml` builds the trusted default branch and invokes the action. It does not build the PR head in the credential-bearing job. Optionally set repository variable `AI_PROVIDER` to `gemini`, `openai`, or `anthropic` (defaults to `gemini` when unset or empty), set `AI_MODEL` to an available model supporting the documented API/JSON behavior, and set secret `AI_PROVIDER_API_KEY` to that provider's key. Review provider terms and billing controls before enabling the workflow. Changes in this working tree must reach the trusted default branch before that workflow uses them.

For client repositories, choose between two update models:
- **Maintained moving tag (`@v1`)**: Automatically receive compatible enhancements and bug fixes without editing workflow files.
- **Audited SHA pin (`@<commit-sha>`)**: Guarantee absolute immutability for strict enterprise compliance.

```yaml
name: AI Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: read

concurrency:
  group: ai-review-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true

jobs:
  review:
    if: >-
      (github.event_name == 'pull_request' &&
       github.event.pull_request.head.repo.full_name == github.repository &&
       !github.event.pull_request.draft) ||
      (github.event_name == 'issue_comment' && github.event.issue.pull_request &&
       (github.event.comment.body == '/review' || startsWith(github.event.comment.body, '/review '))) ||
      (github.event_name == 'pull_request_review_comment' &&
       (github.event.comment.body == '/review' || startsWith(github.event.comment.body, '/review ') || startsWith(github.event.comment.body, '/ask ') || startsWith(github.event.comment.body, '/explain ')))
    runs-on: ubuntu-latest
    timeout-minutes: 3
    permissions:
      contents: read
      pull-requests: write
      issues: write

    steps:
      - name: Run AI Code Review
        uses: Ananthang/ai-code-review@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          provider: ${{ vars.AI_PROVIDER || 'gemini' }}
          model: ${{ vars.AI_MODEL }}
          provider-api-key: ${{ secrets.AI_PROVIDER_API_KEY }}
          allow-external-provider: 'true'
          incremental: 'true'
          min-severity: 'medium'
          require-evidence: 'true'
```

> [!NOTE]
> This workflow safely uses GitHub API calls to inspect diffs and does not checkout or execute untrusted PR code in the runner. For central hosted deployment without workflows, see the [GitHub App rollout design](docs/GITHUB_APP_ROLLOUT.md).

For local Ollama, use the separate instructions in [PROVIDERS.md](docs/PROVIDERS.md); a hosted GitHub runner cannot reach a server on your laptop through its own localhost.

## Configuration

| Input | Default / behavior |
| --- | --- |
| `github-token` | GitHub Actions token; use the standard `GITHUB_TOKEN` bot identity |
| `provider` | `gemini`; also `openai`, `anthropic`, `ollama`, `fake` |
| `model` | Required explicit identifier for the primary review model |
| `fallback-model` | Optional; fallback model to attempt if primary hits HTTP 429 rate limit (e.g. `gemini-2.5-flash-lite`) |
| `provider-api-key` | Required for cloud providers; optional Ollama bearer key |
| `provider-base-url` | Ollama only: `http://127.0.0.1:11434`; remote requires HTTPS and opt-in |
| `allow-external-provider` | `false`; must be true for cloud or remote Ollama |
| `max-files` | 20, ceiling 100 |
| `max-file-bytes` | 20,480, ceiling 102,400 |
| `max-input-bytes` | 81,920, ceiling 512,000; includes serialized instructions and envelope |
| `max-input-tokens` | 12,000, ceiling 100,000; conservative byte-based guard, not actual billing |
| `max-output-tokens` | 2,000, ceiling 8,192; selected model must support this value |
| `max-requests` | Default 1; maximum 2 for an explicitly configured fallback; no HTTP retries |
| `max-findings` | 5, ceiling 50 |
| `review-language` | English |
| `exclude-patterns` | Additional newline/comma-separated globs; secret exclusions remain mandatory |
| `mode` | `comment` only |
| `static-report-paths` | Explicit paths, no glob expansion; SHA-wrapped JSON reports |
| `thinking-level` | `low`; reasoning depth: `minimal`, `low`, `medium`, `high` (for Gemini 3 & 2.5) |
| `fail-on-error` | `false`; set to `true` to fail the GitHub Actions step if the AI review fails |
| `custom-instructions` | Optional; inline rules, or path to a file in the project (defaults to auto-detecting `.github/ai-review.md`) |
| `upgrade-notice` | Optional; prominent upgrade notice banner displayed on PR review summaries and workflow annotations (or via `AI_UPGRADE_NOTICE` env var) |

Only included added lines can receive findings. Fork/draft PRs are skipped. Prompt framing and exclusions reduce risk but cannot eliminate injection, secret exposure, or false positives. No reviewed code is executed by the action itself. No approvals or change requests are submitted.

The included workflow also handles `/review` and `/review exact/path.ts` comments, as well as conversational inline review thread replies (e.g., `/review why is this needed?`, `/ask ...`, or `/explain ...`). The actor must have repository write/maintain/admin permission; denied or unverifiable permission skips review. This feature requires the `issue_comment` and `pull_request_review_comment` workflow triggers. Dedupe recognizes standard `github-actions[bot]` comments; custom PAT/app identities are not supported for maintained-comment ownership.

When an eligible review starts, the action adds 👀 to the triggering `/review` comment. On the first automatic review (no existing bot-owned review summary), it adds 👀 to the PR description instead. Skipped reviews do not receive a start reaction, and reaction permission failures do not stop the review. The reaction records that review started; it remains if the provider later fails. The existing 🚀 comment reaction is retained after the publication flow completes.

Outputs include `status`, `reason-code`, `reviewed-files`, `published-findings`, and token counts where available. Skips/failures may only appear in action outputs and logs; always inspect status before interpreting an old PR summary.

## Custom Review Instructions & Guidelines ("Review Skills")

Client repositories can configure their own custom review rules, architectural guidelines, or team standards to steer what the AI model checks for.

There are three ways to supply custom guidelines:

### 1. Auto-detected Repository File (Default: `.github/ai-review.md`)
Simply add a markdown file at `.github/ai-review.md` (or `.github/review-instructions.md`) in your repository. The action automatically detects and loads it on every review:

```markdown
# Repository Review Guidelines

## Architecture & Framework Rules
- Enforce Next.js App Router and Server Actions best practices.
- Ensure all API route request bodies are validated using Zod schemas before processing.
- Verify user session authentication before executing mutations.

## Production Hygiene & Code Quality
- Flag any leftover \`console.log\` or \`debugger\` statements in backend routes (\`app/api/...\`).
- Disallow \`any\` in TypeScript; require explicit types or \`unknown\` with type narrowing.
- Ensure SQL queries or ORM calls include proper error handling.
```

### 2. External File(s) Anywhere in the Project (Single or Multiple)
If your team keeps documentation or review rules in other directories (outside `.github`), specify the relative path(s) in `custom-instructions`. You can provide a single file, or multiple files separated by newlines or commas:

**Single file:**
```yaml
- uses: Ananthang/ai-code-review@v1
  with:
    custom-instructions: 'docs/architecture/review-guidelines.md'
```

**Multiple files (newline-separated or comma-separated):**
```yaml
- uses: Ananthang/ai-code-review@v1
  with:
    custom-instructions: |
      docs/review-guidelines.md
      standards/security-rules.md
      rules/typescript-standards.md
```
Or:
```yaml
- uses: Ananthang/ai-code-review@v1
  with:
    custom-instructions: 'docs/review-guidelines.md, standards/security-rules.md'
```

**Mixing files with custom inline rules:**
```yaml
- uses: Ananthang/ai-code-review@v1
  with:
    custom-instructions: |
      docs/review-guidelines.md
      - Also ensure all external API calls include a 5-second timeout
      - Flag any raw SQL queries without parameterized inputs
```

The action validates that all paths stay safely within your repository workspace, loads each file's contents, and combines them cleanly for the AI model.

### 3. Inline in Workflow YAML
You can also write custom guidelines directly inside your workflow file:

```yaml
- uses: Ananthang/ai-code-review@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    provider-api-key: ${{ secrets.GEMINI_API_KEY }}
    allow-external-provider: 'true'
    custom-instructions: |
      - Flag all \`console.log\` statements in backend API routes.
      - Ensure all external API fetch calls specify timeouts.
      - Reject hardcoded secrets or fallback tokens in code.
```

> [!NOTE]
> To temporarily disable custom rules when a `.github/ai-review.md` exists, set `custom-instructions: 'none'` or `'off'`.

## Handling Rate Limits (`fallback-model`)

If you are using Google AI Studio free tier and frequently hit `429 Too Many Requests` during rapid commit pushes, you can configure an optional `fallback-model` (such as `gemini-2.5-flash-lite`):

```yaml
- uses: Ananthang/ai-code-review@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    provider-api-key: ${{ secrets.GEMINI_API_KEY }}
    allow-external-provider: 'true'
    model: 'gemini-2.5-flash'
    fallback-model: 'gemini-2.5-flash-lite'
    max-requests: 2
```

- If the primary model returns HTTP 429, the action attempts `fallback-model` only when `max-requests: 2` explicitly permits a second call. With the default of 1, no fallback call is made. HTTP 503 also permits the explicitly budgeted fallback; there are no transport retries.
- When fallback succeeds, the PR summary comment clearly indicates: `gemini / gemini-2.5-flash-lite (fallback on 429)`.
- If no `fallback-model` is specified, no fallback request is attempted.


## Static reports

Produce reports in a separate job without AI credentials, verify the artifact's producing workflow/run in your integration, and supply explicit downloaded paths. Wrap each tool's JSON as:

```json
{"headSha":"EXACT_PR_HEAD_SHA","report":{"tool_specific":"original JSON here"}}
```

`report` may be an array for ESLint. Supported extractors: ESLint, RuboCop, Brakeman, Checkov, SARIF. Paths must map exactly to the repository diff; normalize checkout-specific paths in the producer. Missing/mismatched wrappers, malformed structures and oversized inputs are skipped. A SHA inside a report is not proof of its origin. No real static analyzer execution is bundled with this action.

## Local validation

```sh
npm ci --ignore-scripts
npm test
npm run build
```

Build runs TypeScript checking and regenerates `dist/index.js`. Commit the regenerated bundle with source changes; CI checks for bundle drift. Tests use synthetic content and mock HTTP responses, not paid provider calls. See the implementation review for the latest recorded result and remaining release gates.

## License

[MIT](LICENSE).

Custom instruction files must resolve inside the workspace; escaping symlinks and sibling-directory paths are not read. Recognized credential markers in custom instructions stop review before provider access. Instruction text is included in the selection budget. A missing `/review <file>` target reports `target_file_not_found` without reviewing other files. `fail-on-error: true` fails every partial/failed outcome; intentional skips remain non-failing.


## Low-cost, guarded review

The default review now uses at most **one AI request**, **12,000 estimated input tokens**,
**2,000 output tokens**, and **five findings**, with low reasoning effort where supported.
A configured fallback requires explicitly setting `max-requests: 2`.

Automatic reviews skip unchanged file patches from successful reviews. Manual `/review`
commands force a fresh bounded review. Up to two small relative JS/TS imports can provide
supporting context, fetched at the exact PR commit, using only budget left after the diff.
Medium-or-higher findings must quote their exact added source line by default.

| Input | Default | Purpose |
| --- | --- | --- |
| `incremental` | `true` | Reuse successful file-patch review checkpoints |
| `max-context-bytes` | `2048` | Total optional source context bytes; `0` disables; ceiling `8192` |
| `min-severity` | `medium` | Publish only this severity or higher |
| `require-evidence` | `true` | Require an exact quote of the finding's changed source line |

See [Low-cost review and security design](docs/LOW_COST_REVIEW.md) for configuration,
trust boundaries, coverage limitations, and checkpoint behavior.
