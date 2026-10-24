# Provider support and configuration

Updated 24 October 2026. All four adapters are implemented and tested with mocked HTTP contracts. No live authentication, model-quality, quota, pricing, or deployment validation was performed in this review.

## Supported adapters

| `provider` | API | Key | External opt-in |
| --- | --- | --- | --- |
| `gemini` | Gemini `generateContent` | `provider-api-key` or `GEMINI_API_KEY` | Required |
| `openai` | OpenAI Responses | `provider-api-key` or `OPENAI_API_KEY` | Required |
| `anthropic` | Claude Messages | `provider-api-key` or `ANTHROPIC_API_KEY` | Required |
| `ollama` | Ollama `/api/chat` | Optional input or `OLLAMA_API_KEY` | Required for non-loopback servers |
| `fake` | No network; test fixture | None | No |

Use `anthropic` for Claude. Select an explicit model with the required API and JSON-output behavior. Models are not downloaded, discovered, substituted, or upgraded automatically. Model names in tests are synthetic; consult your account's model availability. A consumer running `fake` is only exercising plumbing and receives no meaningful AI review.

## Cloud setup

Use the workflow in the README. Set `AI_MODEL` and the matching `AI_PROVIDER_API_KEY` secret. Optionally set repository variable `AI_PROVIDER`; the workflow uses `${{ vars.AI_PROVIDER || 'gemini' }}`, so an unset or empty variable defaults to Gemini. For example, choosing `openai` selects Responses; choosing `anthropic` selects Messages. The action's provider-specific environment fallback is used only when `provider-api-key` is absent, so another provider's secret is not accidentally reused.

OpenAI requests use `store: false`, a JSON-object response format and `max_output_tokens`. Claude requests use a system instruction, one user message and `max_tokens`, with API version `2023-06-01`. Claude JSON is requested by prompt and validated locally; the action does not claim schema-enforced output from that API. Gemini uses JSON MIME output and `maxOutputTokens`. All responses must decode into the same bounded findings schema before line validation.

These settings do not promise zero retention under a provider's service policies, free usage, or compatibility with every model. Incompatible models fail safely without fallback. Review current provider terms and account controls before processing private code.

## Ollama setup

Run Ollama with the chosen model already installed on a trusted runner. For local mode, configure a dedicated self-hosted runner and change the review step to:

```yaml
# Inside a review job on your trusted self-hosted runner:
- uses: Ananthang/ai-code-review@REVIEWED_ACTION_COMMIT_SHA
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    provider: ollama
    model: ${{ vars.OLLAMA_MODEL }}
    provider-base-url: http://127.0.0.1:11434
    allow-external-provider: 'false'
```

Replace the action SHA before use. Preserve the same fork/draft gating, permissions and concurrency as the README. Keep untrusted build/test jobs off this persistent credential-bearing runner. Loopback refers to the runner itself, not the developer's computer.

A remote Ollama origin must use HTTPS and `allow-external-provider: true`. Optional `provider-api-key` is sent as a bearer token to that explicitly configured origin. URL credentials, paths, queries and fragments are rejected; redirects are not followed. The administrator is responsible for endpoint trust, TLS, DNS, network access and server access controls. A loopback proxy can still forward data externally; local addressing alone cannot prove local processing.

The adapter uses non-streaming JSON output, `num_predict` for the output cap, and a requested context size based on the input guard plus output limit. Hardware/model context capacity may be lower; verify it on the runner. Cold loading can exceed the 60-second provider timeout. The action does not install a model or silently select another one.

## Shared controls

- Exactly one generation HTTP request per adapter invocation, with no SDK retry, redirect or provider fallback.
- Whole-file selection measures the serialized request body, including prompts and provider envelope; the transport rechecks it before sending.
- A deliberately conservative one-token-per-UTF-8-byte input guard replaces the previous optimistic 3.5-byte estimate. It may skip more files; reported provider usage supersedes the estimate when available. It is not an invoice or a strict monetary budget.
- Native fetch receives the abort signal. Responses are limited to 1 MiB and schema findings to 50. Incomplete/truncated or invalid responses fail review rather than implying clean code.
- External error bodies, URLs and arbitrary exceptions are not forwarded to logs. HTTP failure codes are classified inside the transport; orchestration publishes a generic failure status.
- The model has no tools, repository execution capability, or automatic fix mechanism. Returned text remains untrusted.

## Verification before live use

For each chosen provider, run a synthetic PR with a known bug, a clean change, a rerun, and an intentionally invalid model. Check line placement, summary, token usage, no duplicates, sanitized failure behavior, actual cost and duration. Record model identifier and date. Do not reuse results from the fake provider as model-quality evidence.

## Official API references consulted

- [OpenAI text generation](https://developers.openai.com/api/docs/guides/text) and [JSON/structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
- [Claude Messages API](https://platform.claude.com/docs/en/api/messages/create).
- [Ollama chat API](https://docs.ollama.com/api/chat).
- [Gemini content generation](https://ai.google.dev/api/generate-content).

These references informed request/response contracts; model availability and pricing were not asserted or tested.
