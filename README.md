# AI Code Review Action

An open-source GitHub Action providing bounded, comment-only AI feedback on pull requests using Gemini and a provider-neutral interface.

**Status:** Implemented (v0.2.0). All core milestones (M1–M6) are implemented, verified by deterministic tests, and bundled for standalone GitHub Actions runtime execution.

- [Product requirements](docs/PRD.md): scope, user journeys, requirements, and acceptance criteria.
- [Architecture](docs/ARCHITECTURE.md): components, trust boundaries, configuration, and failure handling.
- [Delivery plan](docs/DELIVERY_PLAN.md): sequenced work, validation, risks, and release gates.

---

## Key Features

- **Bounded & Comment-Only:** Operates strictly in comment mode. Never approves, requests changes, or blocks merges.
- **Provider-Neutral Architecture:** Pluggable `AIProvider` contract with full Google Gemini adapter (`@google/genai`) and deterministic `FakeProvider` for testing.
- **Strict Diff & Line Validation:** Parses unified diffs, extracts hunk headers, reconciles line counts, and guarantees findings are attached *only* to verified newly added (`+`) lines.
- **Defense in Depth Security:**
  - Mandatory exclusion of secret files (`.env*`, `*.pem`, `*.key`, `id_rsa`, `credentials.json`, `.aws/*`, `.ssh/*`).
  - High-confidence regex screening for credential markers in diffs (AWS keys, GitHub tokens, private keys).
  - Skips binary files, vendor directories (`node_modules`), lockfiles, and minified assets.
  - Neutralizes prompt injection attempts and sanitizes output (@-mentions and HTML tags).
  - Explicit external opt-in required (`allow-external-provider: true`) before code diffs leave GitHub.
- **Rerun Deduplication:** Computes stable SHA-256 fingerprints embedded invisibly in comments (`<!-- ai-code-review-fingerprint:v1:... -->`). Reruns on unchanged code produce zero duplicate comments.
- **Stale Head Guard:** Rechecks the latest PR commit SHA immediately before publishing; safely discards results if the PR head changed while review was calculating.
- **Maintained Summary:** Creates or updates a single markdown summary comment (`<!-- ai-code-review-summary:v1 -->`) tracking coverage, exclusions, findings by severity, and token usage.
- **Static Analyzer Ingestion:** Consumes bounded JSON/SARIF reports (ESLint, RuboCop, Brakeman, Checkov, SARIF) produced by separate, credential-free CI jobs.

---

## Quickstart

### 1. Add Workflow to Repository

Create `.github/workflows/ai-review.yml`:

```yaml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    name: AI Review
    runs-on: ubuntu-latest
    steps:
      - name: Run AI Code Review Action
        uses: ananthan/ai-code-review@v0.2.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          provider: 'gemini'
          model: 'gemini-2.5-flash'
          provider-api-key: ${{ secrets.GEMINI_API_KEY }}
          allow-external-provider: 'true'
          max-findings: 10
          max-files: 20
```

---

## Configuration Reference

| Input | Description | Default | Ceiling |
| --- | --- | --- | --- |
| `github-token` | GitHub token (`pull-requests:write`, `issues:write`) | `${{ github.token }}` | Required |
| `provider` | Provider adapter (`gemini`, `fake`) | `gemini` | `gemini` \| `fake` |
| `model` | Explicit model identifier (no silent fallback) | *Required* | Explicit string |
| `provider-api-key` | Secret API key for AI provider | `''` | Masked in logs |
| `allow-external-provider` | Explicit opt-in for diffs leaving GitHub | `false` | Boolean |
| `max-files` | Maximum files to review | `20` | `100` |
| `max-file-bytes` | Maximum patch size per file | `20480` (20 KiB) | `102400` (100 KiB) |
| `max-input-bytes` | Total serialized input budget | `81920` (80 KiB) | `512000` (500 KiB) |
| `max-input-tokens` | Estimated input tokens ceiling guard | `24000` | `100000` |
| `max-output-tokens` | Provider output token cap | `4000` | `8192` |
| `max-requests` | Max provider requests per run | `1` | `1` (Fixed in MVP) |
| `max-findings` | Max inline findings published | `10` | `50` |
| `review-language` | Natural language for feedback | `English` | Any valid language |
| `exclude-patterns` | Additional glob patterns to exclude | `''` | Newline/comma separated |
| `mode` | Review mode | `comment` | Only `comment` |
| `static-report-paths` | Paths/globs to local static tool reports | `''` | Local paths |

---

## Local Development & Testing

```bash
# Install dependencies
npm install

# Run TypeScript type check
npm run typecheck

# Run Vitest test suite (48 unit & integration tests)
npm test

# Build single-file bundled action (dist/index.js)
npm run bundle
```

---

## License

[MIT](LICENSE) © 2026 AI Code Review Contributors
