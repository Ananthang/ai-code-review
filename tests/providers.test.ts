import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpProvider, ollamaEndpoint, ProviderName } from '../src/providers/http.js';
import { createProvider } from '../src/providers/factory.js';
import { parseConfig } from '../src/config.js';

const input = { files: [{ path: 'a.ts', patch: '@@ -0,0 +1 @@\n+bad()' }], language: 'English', maxFindings: 10 };
const content = JSON.stringify({ summary: 'Test', findings: [] });
const cases: Array<[ProviderName, unknown, string, string]> = [
  ['gemini', { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: content }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 } }, 'generativelanguage.googleapis.com', 'x-goog-api-key'],
  ['openai', { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }], usage: { input_tokens: 12, output_tokens: 4 } }, 'api.openai.com', 'Authorization'],
  ['anthropic', { stop_reason: 'end_turn', content: [{ type: 'text', text: content }], usage: { input_tokens: 12, output_tokens: 4 } }, 'api.anthropic.com', 'x-api-key'],
  ['ollama', { done: true, done_reason: 'stop', message: { content }, prompt_eval_count: 12, eval_count: 4 }, '127.0.0.1', 'Authorization'],
];
afterEach(() => vi.unstubAllGlobals());
describe('Provider HTTP contracts (mocked; no live billing)', () => {
  it.each(cases)('%s sends one bounded request and decodes usage', async (name, response, host, authHeader) => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal('fetch', request);
    const provider = createProvider(parseConfig({ githubToken: 'test-token', provider: name, model: 'explicit-test-model', providerApiKey: 'sentinel-key', allowExternalProvider: true }));
    const signal = new AbortController().signal;
    expect(await provider.review(input, signal)).toEqual({ summary: 'Test', findings: [], usage: { inputTokens: 12, outputTokens: 4 } });
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(new URL(url).hostname).toBe(host);
    expect(init.signal).toBe(signal);
    expect(init.redirect).toBe('error');
    expect(init.headers[authHeader]).toContain('sentinel-key');
    expect(init.body).not.toContain('sentinel-key');
    const body = JSON.parse(init.body);
    expect(body.generationConfig?.maxOutputTokens ?? body.max_output_tokens ?? body.max_tokens ?? body.options?.num_predict).toBe(4000);
    if (name === 'openai') expect(body.store).toBe(false);
    if (name === 'ollama') expect(body.stream).toBe(false);
  });

  it.each(cases)('%s never retries quota errors or exposes response bodies', async (name) => {
    const request = vi.fn().mockResolvedValue(new Response('PRIVATE_SOURCE sentinel-key', { status: 429 }));
    vi.stubGlobal('fetch', request);
    const provider = new HttpProvider(name, { apiKey: 'sentinel-key', model: 'test' });
    await expect(provider.review(input, new AbortController().signal)).rejects.toThrow(/^provider_http_429$/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(cases)('%s rejects a malformed successful response', async (name) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"private":"SOURCE"}')));
    await expect(new HttpProvider(name, { apiKey: 'key', model: 'test' }).review(input, new AbortController().signal)).rejects.toThrow();
  });

  it('counts system instructions and serialization before making a request', async () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    await expect(new HttpProvider('openai', { apiKey: 'key', model: 'test', maxInputBytes: 100 }).review(input, new AbortController().signal)).rejects.toThrow('request_budget_exceeded');
    expect(request).not.toHaveBeenCalled();
  });

  it('does not start an aborted request', async () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const controller = new AbortController(); controller.abort();
    await expect(new HttpProvider('openai', { apiKey: 'key', model: 'test' }).review(input, controller.signal)).rejects.toThrow('request_aborted');
    expect(request).not.toHaveBeenCalled();
  });

  it('propagates cancellation to an in-flight transport', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('PRIVATE_SOURCE')), { once: true });
    })));
    const controller = new AbortController();
    const pending = new HttpProvider('openai', { apiKey: 'key', model: 'test' }).review(input, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/^request_aborted$/);
  });

  it('rejects oversized response bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('a'.repeat(1024 * 1024 + 1))));
    await expect(new HttpProvider('openai', { apiKey: 'key', model: 'test' }).review(input, new AbortController().signal)).rejects.toThrow('response_too_large');
  });

  it('rejects truncated model output even if its JSON looks valid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'incomplete', output: [] }))));
    await expect(new HttpProvider('openai', { apiKey: 'key', model: 'test' }).review(input, new AbortController().signal)).rejects.toThrow('incomplete_response');
  });

  it('requires HTTPS and opt-in for non-loopback Ollama without permitting embedded credentials', () => {
    expect(ollamaEndpoint()).toBe('http://127.0.0.1:11434/api/chat');
    expect(() => ollamaEndpoint('http://remote.example', true)).toThrow();
    expect(() => ollamaEndpoint('https://remote.example', false)).toThrow();
    expect(() => ollamaEndpoint('https://user:pass@remote.example', true)).toThrow();
    expect(ollamaEndpoint('https://remote.example', true)).toBe('https://remote.example/api/chat');
  });
});

describe('Review regression protections', () => {
  it.each(cases)('%s sends no credentials embedded in instructions', async (name) => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const provider = new HttpProvider(name, { apiKey: 'test-key', model: 'test' });
    await expect(provider.review({ ...input, customInstructions: 'Service key: AKIAIOSFODNN7EXAMPLE' }, new AbortController().signal)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each(cases)('%s does not retry 503', async (name) => {
    const request = vi.fn().mockResolvedValue(new Response('', { status: 503 })); vi.stubGlobal('fetch', request);
    await expect(new HttpProvider(name, { apiKey: 'test-key', model: 'test' }).review(input, new AbortController().signal)).rejects.toThrow('provider_http_503');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(['MAX_TOKENS', undefined])('rejects Gemini finish reason %s even with valid empty findings', async (reason) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [{ finishReason: reason, content: { parts: [{ text: '{"findings":[]}' }] } }] }))));
    await expect(new HttpProvider('gemini', { apiKey: 'key', model: 'test' }).review(input, new AbortController().signal)).rejects.toThrow('incomplete_response');
  });
});
