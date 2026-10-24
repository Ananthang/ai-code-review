import { AIProvider, ReviewInput, ProviderResult } from '../types.js';
import { buildReviewPrompt, SYSTEM_INSTRUCTION } from '../review/prompt.js';
import { ProviderResponseSchema } from '../review/validate.js';

export type ProviderName = 'gemini' | 'openai' | 'anthropic' | 'ollama';
export interface HttpProviderOptions {
  apiKey: string;
  model: string;
  maxOutputTokens?: number;
  maxInputBytes?: number;
  maxInputTokens?: number;
  baseUrl?: string;
  allowExternalProvider?: boolean;
}

export function ollamaEndpoint(baseUrl = 'http://127.0.0.1:11434', allowExternal = false): string {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Ollama URL must be an origin without credentials, path, query or fragment');
  }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || (!local && (!allowExternal || url.protocol !== 'https:'))) {
    throw new Error('Remote Ollama requires HTTPS and external-provider opt-in');
  }
  return `${url.origin}/api/chat`;
}

// One native fetch per review: no SDK retries, redirects, tools or provider fallback.
export class HttpProvider implements AIProvider {
  constructor(public readonly name: ProviderName, private readonly options: HttpProviderOptions) {
    if (!options.model || (name !== 'ollama' && !options.apiKey)) throw new Error('Provider configuration missing');
    if (name === 'ollama') ollamaEndpoint(options.baseUrl, options.allowExternalProvider);
  }

  public requestBody(input: ReviewInput): object {
    const prompt = buildReviewPrompt(input);
    const model = this.options.model;
    const limit = this.options.maxOutputTokens ?? 4000;
    switch (this.name) {
      case 'gemini': return {
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: limit },
      };
      case 'openai': return {
        model, instructions: SYSTEM_INSTRUCTION, input: prompt, store: false,
        max_output_tokens: limit, text: { format: { type: 'json_object' } },
      };
      case 'anthropic': return {
        model, system: SYSTEM_INSTRUCTION, max_tokens: limit,
        messages: [{ role: 'user', content: prompt }],
      };
      case 'ollama': return {
        model, stream: false, format: 'json',
        messages: [{ role: 'system', content: SYSTEM_INSTRUCTION }, { role: 'user', content: prompt }],
        options: { num_predict: limit, num_ctx: (this.options.maxInputTokens ?? 24000) + limit },
      };
    }
  }

  public async review(input: ReviewInput, signal: AbortSignal): Promise<ProviderResult> {
    try {
      signal.throwIfAborted();
      const body = JSON.stringify(this.requestBody(input));
      const bytes = Buffer.byteLength(body, 'utf8');
      if (bytes > (this.options.maxInputBytes ?? 81920) || bytes > (this.options.maxInputTokens ?? 24000)) {
        throw new Error('request_budget_exceeded');
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      let url: string;
      switch (this.name) {
        case 'gemini':
          url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.options.model.replace(/^models\//, ''))}:generateContent`;
          headers['x-goog-api-key'] = this.options.apiKey;
          break;
        case 'openai':
          url = 'https://api.openai.com/v1/responses';
          headers.Authorization = `Bearer ${this.options.apiKey}`;
          break;
        case 'anthropic':
          url = 'https://api.anthropic.com/v1/messages';
          headers['x-api-key'] = this.options.apiKey;
          headers['anthropic-version'] = '2023-06-01';
          break;
        case 'ollama':
          url = ollamaEndpoint(this.options.baseUrl, this.options.allowExternalProvider);
          if (this.options.apiKey) headers.Authorization = `Bearer ${this.options.apiKey}`;
          break;
      }
      let response = await fetch(url, { method: 'POST', headers, body, signal, redirect: 'error' });
      // If server returns 503 (transient overload), retry once after a brief delay
      if (response.status === 503 && !signal.aborted) {
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 2000));
        signal.throwIfAborted();
        response = await fetch(url, { method: 'POST', headers, body, signal, redirect: 'error' });
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`provider_http_${response.status}`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('empty_response');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1024 * 1024) throw new Error('response_too_large');
          chunks.push(value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // Reject action-bearing response blocks, even when text accompanies them.
      const blocks = [
        ...(Array.isArray(data.output) ? data.output : []),
        ...(Array.isArray(data.content) ? data.content : []),
        ...(data.candidates?.[0]?.content?.parts ?? []),
      ];
      if (data.message?.tool_calls?.length || blocks.some((block: any) =>
        block.functionCall || block.executableCode || block.codeExecutionResult ||
        /(?:tool|function|computer|shell).*?(?:call|use)/i.test(block.type ?? '')
      )) throw new Error('invalid_response');
      let text: string;
      let inputTokens: unknown;
      let outputTokens: unknown;
      switch (this.name) {
        case 'gemini':
          const finishReason = data.candidates?.[0]?.finishReason;
          if (finishReason && !['STOP', 'MAX_TOKENS'].includes(finishReason)) {
            throw new Error('incomplete_response');
          }
          text = (data.candidates?.[0]?.content?.parts ?? [])
            .filter((p: any) => !p.thought)
            .map((p: any) => p.text ?? '')
            .join('');
          inputTokens = data.usageMetadata?.promptTokenCount;
          outputTokens = data.usageMetadata?.candidatesTokenCount;
          break;
        case 'openai':
          if (data.status !== 'completed') throw new Error('incomplete_response');
          text = data.output.filter((o: any) => o.type === 'message').flatMap((o: any) => o.content)
            .filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
          inputTokens = data.usage?.input_tokens; outputTokens = data.usage?.output_tokens;
          break;
        case 'anthropic':
          if (data.stop_reason !== 'end_turn') throw new Error('incomplete_response');
          text = data.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
          inputTokens = data.usage?.input_tokens; outputTokens = data.usage?.output_tokens;
          break;
        case 'ollama':
          if (data.done !== true || data.done_reason !== 'stop') throw new Error('incomplete_response');
          text = data.message.content;
          inputTokens = data.prompt_eval_count; outputTokens = data.eval_count;
          break;
      }
      const rawText = text.trim();
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      const cleanJson = jsonMatch ? jsonMatch[0] : rawText.replace(/^```(?:json)?\s*|\s*```$/g, '');
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(cleanJson);
      } catch {
        throw new Error('invalid_response');
      }
      const parsed = ProviderResponseSchema.safeParse(parsedJson);
      if (!parsed.success) throw new Error('invalid_response');
      const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
      return { ...parsed.data, usage: { inputTokens: count(inputTokens), outputTokens: count(outputTokens) } };
    } catch (error) {
      // Never propagate provider bodies, URLs, source strings or arbitrary transport errors.
      const code = error instanceof Error && /^(provider_http_\d{3}|request_budget_exceeded|response_too_large|incomplete_response|invalid_response)$/.test(error.message)
        ? error.message : signal.aborted ? 'request_aborted' : 'provider_request_failed';
      throw new Error(code);
    }
  }
}
