# ReviewPilot AI - Intelligent PR Code Review & Q&A

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-ReviewPilot%20AI-blueviolet?logo=github-actions&logoColor=white)](https://github.com/marketplace/actions/reviewpilot-ai-intelligent-pr-code-review-q-a)
[![Version](https://img.shields.io/github/v/release/Ananthang/ai-code-review?label=release&color=2ea44f)](https://github.com/marketplace/actions/reviewpilot-ai-intelligent-pr-code-review-q-a)
[![Tests](https://img.shields.io/badge/tests-225%20passed-brightgreen)](https://github.com/Ananthang/ai-code-review/actions)
[![Runtime](https://img.shields.io/badge/node-24-blue)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**ReviewPilot AI** is an intelligent, bounded, comment-only GitHub Action that performs automated code reviews on pull requests and engages in interactive thread discussions.

Supports **Google Gemini**, **OpenAI**, **Anthropic Claude**, and **Ollama** via a unified, provider-neutral architecture.

---

## ✨ Key Features

- 🤖 **Multi-Provider AI**: Native support for Google Gemini (`gemini-2.0-flash`, `models/gemini-3.6-flash`), OpenAI (`gpt-4o-mini`, `gpt-4o`), Anthropic Claude (`claude-3-5-haiku`, `claude-3-5-sonnet`), and Ollama.
- 💬 **Conversational PR Q&A**: Reply directly to any review finding with `/ask <question>` or `/explain` to get instant clarification and code examples from the AI.
- 🔄 **On-Demand & Targeted Reviews**: Comment `/review` to re-trigger an analysis on the latest changes, or `/review <path>` to target a single critical file.
- 🎯 **Custom Guidelines & Rules**: Steer reviews using your team's coding standards by adding a simple `.github/ai-review.md` file or inline instructions.
- 🚫 **Flexible File Exclusions**: Skip tests, generated files, and documentation with `exclude-patterns`. Common secrets, lockfiles, and minified bundles are automatically excluded by default.
- 🛡️ **Guarded & Cost-Controlled**: Enforces strict token ceilings, single-request budgets, and patch-level deduplication to prevent comment spam and unexpected API costs.
- 🔒 **Security-First Boundary**: Never executes untrusted PR code, restricts command triggers to authorized maintainers, and automatically masks all API keys and secrets in workflow logs.

---

## 🚀 Quick Start (1 Minute)

Create `.github/workflows/reviewpilot.yml` in your repository:

```yaml
name: ReviewPilot AI

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

concurrency:
  group: reviewpilot-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: false

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Run ReviewPilot AI
        uses: Ananthang/ai-code-review@v1
        with:
          provider: gemini
          model: ${{ vars.AI_MODEL || 'models/gemini-3.6-flash' }}
          provider-api-key: ${{ secrets.GEMINI_API_KEY }}
          allow-external-provider: 'true'
          thinking-level: 'low'
          fail-on-error: 'false'
          exclude-patterns: |
            **/*.test.ts
            **/*.spec.ts
            docs/**
```

> [!TIP]
> Add `GEMINI_API_KEY` (or your chosen provider's key) under your repository's **Settings → Secrets and variables → Actions**.

---

## 🔌 Supported Providers & Setup

ReviewPilot AI uses a unified transport layer. Switch providers simply by changing the `provider` and `model` inputs:

### 1. Google Gemini (Default)
```yaml
- uses: Ananthang/ai-code-review@v1
  with:
    provider: gemini
    model: 'models/gemini-3.6-flash' # or gemini-2.0-flash
    provider-api-key: ${{ secrets.GEMINI_API_KEY }}
    allow-external-provider: 'true'
```

### 2. OpenAI
```yaml
- uses: Ananthang/ai-code-review@v1
  with:
    provider: openai
    model: 'gpt-4o-mini' # or gpt-4o, o3-mini
    provider-api-key: ${{ secrets.OPENAI_API_KEY }}
    allow-external-provider: 'true'
```

### 3. Anthropic Claude
```yaml
- uses: Ananthang/ai-code-review@v1
  with:
    provider: anthropic
    model: 'claude-3-5-haiku-latest' # or claude-3-5-sonnet-latest
    provider-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    allow-external-provider: 'true'
```

### 4. Ollama (Self-Hosted / Local)
```yaml
- uses: Ananthang/ai-code-review@v1
  with:
    provider: ollama
    model: 'qwen2.5-coder:7b'
    provider-base-url: 'https://ollama.your-domain.com'
    allow-external-provider: 'true'
```

---

## 💬 Interactive PR Commands & Q&A

Maintainers and collaborators can interact directly with ReviewPilot AI on any pull request:

| Command | Where to Post | Description |
| :--- | :--- | :--- |
| `/ask <question>` | Reply on any inline review comment | Ask for clarification or advice on an issue (e.g. `/ask How should I refactor this?`) |
| `/explain` | Reply on any inline review comment | Request a deeper explanation of the finding and potential impact |
| `/review` | PR conversation timeline comment | Trigger a fresh review on the latest commit |
| `/review <path>` | PR conversation timeline comment | Run a targeted review on only the specified file (e.g. `/review src/auth.ts`) |

**Interactive Flow:**
1. You post `/ask` or `/review`.
2. ReviewPilot AI reacts with **👀** to confirm authorization and start processing.
3. ReviewPilot AI completes the request, updates with **🚀**, and publishes the conversational reply.

---

## 🎯 Custom Review Instructions ("Review Skills")

You can guide the AI model to enforce team-specific architecture, coding conventions, and security rules.

### Option A: Auto-detected File (Recommended)
Add `.github/ai-review.md` in your repository. ReviewPilot AI automatically detects and applies it:

```markdown
# Team Review Standards

## Architecture & Framework
- Enforce Next.js App Router and Server Action best practices.
- Ensure all API inputs are validated using Zod schemas before processing.

## Code Hygiene & Security
- Flag any leftover `console.log` statements in backend API routes (`app/api/**`).
- Ensure all external network requests specify a timeout via `AbortSignal.timeout(...)`.
- Reject hardcoded secrets, API keys, or fallback tokens in source code.
```

### Option B: Inline in Workflow YAML
```yaml
- uses: Ananthang/ai-code-review@v1
  with:
    custom-instructions: |
      - Flag all `console.log` statements in backend API routes.
      - Ensure external API calls specify request timeouts.
      - Disallow hardcoded secrets or fallback tokens in source code.
```

---

## 🚫 Excluding Files from Review (`exclude-patterns`)

Configure `exclude-patterns` in your workflow to skip files that do not need AI analysis:

```yaml
- uses: Ananthang/ai-code-review@v1
  with:
    exclude-patterns: |
      **/*.test.ts
      **/*.spec.ts
      docs/**
      *.generated.*
      migrations/**
```

### Automatic Built-in Exclusions
For safety and token efficiency, the following files are **always automatically skipped**:
- **Secrets & Keys**: `.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `credentials.json`, `.aws/**`, `.ssh/**`
- **Lockfiles**: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Gemfile.lock`, `Cargo.lock`, `go.sum`
- **Build Output**: `node_modules/**`, `dist/**`, `build/**`, `.next/**`, `target/**`, `coverage/**`
- **Media & Binaries**: `.png`, `.jpg`, `.svg`, `.ico`, `.pdf`, `.zip`, `.wasm`, `.dylib`
- **Minified Code**: `*.min.js`, `*.min.css`

---

## ⚙️ Configuration Reference

| Input | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `provider` | string | `gemini` | AI provider (`gemini`, `openai`, `anthropic`, `ollama`) |
| `model` | string | required | Primary AI model identifier |
| `fallback-model` | string | `''` | Optional fallback model if primary hits HTTP 429 |
| `provider-api-key` | string | `''` | API key for cloud AI providers (automatically masked in logs) |
| `allow-external-provider` | boolean | `'false'` | Must be `'true'` when using cloud providers or remote Ollama |
| `exclude-patterns` | string | `''` | Additional glob patterns to exclude from review |
| `custom-instructions` | string | auto | Custom guidelines (defaults to `.github/ai-review.md` if present) |
| `thinking-level` | string | `'low'` | Reasoning effort: `minimal`, `low`, `medium`, `high` (for reasoning models) |
| `min-severity` | string | `'medium'` | Minimum severity to publish: `low`, `medium`, `high`, `critical` |
| `fail-on-error` | boolean | `'false'` | Set to `'true'` to fail the GitHub Actions job if review encounters an error |
| `max-files` | number | `20` | Maximum changed files evaluated per review |
| `max-input-tokens` | number | `12000` | Token budget ceiling to control review costs |
| `max-output-tokens` | number | `2000` | Maximum token limit for the AI model output |
| `incremental` | boolean | `'true'` | Skip previously reviewed, unchanged file patches on subsequent pushes |

---

## 🛡️ Security & Privacy Architecture

- **No Code Execution**: ReviewPilot AI only inspects Git diffs using the official GitHub REST API. Untrusted pull request code is never executed inside the runner.
- **Collaborator Access Control**: Commands (`/review`, `/ask`) only respond to authorized repository collaborators with write, maintain, or admin permissions.
- **Strict Data Masking**: All API keys, tokens, and authorization headers are masked before any log output is generated.
- **Comment-Only Mode**: ReviewPilot AI posts advisory comments and discussions; it never submits formal GitHub Approvals or Request Changes blocks.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
