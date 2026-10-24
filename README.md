# AI Code Review Action

A TypeScript GitHub Action for bounded, advisory pull-request feedback. Supports Gemini, OpenAI, Anthropic Claude, and Ollama through a shared HTTP transport, plus a deterministic fake provider for tests.

**Status: implemented POC, locally tested; not yet live-certified or production-ready.** Passing deterministic tests is not evidence of model accuracy, actual cost, or completion of the company-pilot gates.

- [Code-review-only AI guard](docs/AI_GUARD.md)
- [Implementation review and remaining issues](docs/IMPLEMENTATION_REVIEW.md)
- [Provider setup and behavior](docs/PROVIDERS.md)
- [Product requirements](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Delivery plan](docs/DELIVERY_PLAN.md)

## Setup

For this repository, `.github/workflows/review.yml` builds the trusted default branch and invokes the action. It does not build the PR head in the credential-bearing job. Optionally set repository variable `AI_PROVIDER` to `gemini`, `openai`, or `anthropic` (defaults to `gemini` when unset or empty), set `AI_MODEL` to an available model supporting the documented API/JSON behavior, and set secret `AI_PROVIDER_API_KEY` to that provider's key. Review provider terms and billing controls before enabling the workflow. Changes in this working tree must reach the trusted default branch before that workflow uses them.

For another repository, publish the bundled action first, then replace `REVIEWED_ACTION_COMMIT_SHA` below with its full reviewed commit SHA. This is a template, not an assertion that a release tag exists.

```yaml
name: AI Review
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
  issues: write
concurrency:
  group: ai-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review:
    if: github.event.pull_request.head.repo.full_name == github.repository && !github.event.pull_request.draft
    runs-on: ubuntu-latest
    timeout-minutes: 3
    steps:
      - uses: Ananthang/ai-code-review@REVIEWED_ACTION_COMMIT_SHA
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          provider: ${{ vars.AI_PROVIDER || 'gemini' }}
          model: ${{ vars.AI_MODEL }}
          provider-api-key: ${{ secrets.AI_PROVIDER_API_KEY }}
          allow-external-provider: 'true'
```

For local Ollama, use the separate instructions in [PROVIDERS.md](docs/PROVIDERS.md); a hosted GitHub runner cannot reach a server on your laptop through its own localhost.

## Configuration

| Input | Default / behavior |
| --- | --- |
| `github-token` | GitHub Actions token; use the standard `GITHUB_TOKEN` bot identity |
| `provider` | `gemini`; also `openai`, `anthropic`, `ollama`, `fake` |
| `model` | Required explicit identifier; no substitution or fallback |
| `provider-api-key` | Required for cloud providers; optional Ollama bearer key |
| `provider-base-url` | Ollama only: `http://127.0.0.1:11434`; remote requires HTTPS and opt-in |
| `allow-external-provider` | `false`; must be true for cloud or remote Ollama |
| `max-files` | 20, ceiling 100 |
| `max-file-bytes` | 20,480, ceiling 102,400 |
| `max-input-bytes` | 81,920, ceiling 512,000; includes serialized instructions and envelope |
| `max-input-tokens` | 24,000, ceiling 100,000; conservative byte-based guard, not actual billing |
| `max-output-tokens` | 4,000, ceiling 8,192; selected model must support this value |
| `max-requests` | 1; no automatic retries |
| `max-findings` | 10, ceiling 50 |
| `review-language` | English |
| `exclude-patterns` | Additional newline/comma-separated globs; secret exclusions remain mandatory |
| `mode` | `comment` only |
| `static-report-paths` | Explicit paths, no glob expansion; SHA-wrapped JSON reports |
| `thinking-level` | `medium`; reasoning depth: `minimal`, `low`, `medium`, `high` (for Gemini 3 & 2.5) |
| `fail-on-error` | `false`; set to `true` to fail the GitHub Actions step if the AI review fails |
| `custom-instructions` | Optional; inline rules, or path to a file in the project (defaults to auto-detecting `.github/ai-review.md`) |

Only included added lines can receive findings. Fork/draft PRs are skipped. Prompt framing and exclusions reduce risk but cannot eliminate injection, secret exposure, or false positives. No reviewed code is executed by the action itself. No approvals or change requests are submitted.

The included workflow also handles `/review` and `/review exact/path.ts` comments. The actor must have repository write/maintain/admin permission; denied or unverifiable permission skips review. This feature requires the `issue_comment` workflow trigger. Dedupe recognizes standard `github-actions[bot]` comments; custom PAT/app identities are not supported for maintained-comment ownership.

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

### 2. External File Anywhere in the Project
If your team keeps documentation or review rules in another directory (outside `.github`), specify the relative path in `custom-instructions`:

```yaml
- uses: Ananthang/ai-code-review@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    provider-api-key: ${{ secrets.GEMINI_API_KEY }}
    allow-external-provider: 'true'
    custom-instructions: 'docs/architecture/review-guidelines.md'
    # Or 'standards/code-quality.txt', 'rules/backend-rules.md', etc.
```

The action validates that the path stays safely within your repository workspace and loads its contents.

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
