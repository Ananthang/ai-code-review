import { GoogleGenAI } from '@google/genai';
import { AIProvider, Finding, ProviderResult, ReviewInput } from '../types.js';
import { buildReviewPrompt, SYSTEM_INSTRUCTION } from '../review/prompt.js';
import { ProviderResponseSchema } from '../review/validate.js';

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  maxOutputTokens?: number;
}

export class GeminiProvider implements AIProvider {
  public readonly name = 'gemini';
  private readonly ai: GoogleGenAI;
  private readonly model: string;
  private readonly maxOutputTokens: number;

  constructor(options: GeminiProviderOptions) {
    if (!options.apiKey) {
      throw new Error('Gemini API key is required');
    }
    if (!options.model) {
      throw new Error('Explicit Gemini model identifier is required');
    }

    this.ai = new GoogleGenAI({ apiKey: options.apiKey });
    this.model = options.model;
    this.maxOutputTokens = options.maxOutputTokens ?? 4000;
  }

  public async review(input: ReviewInput, signal: AbortSignal): Promise<ProviderResult> {
    if (signal.aborted) {
      throw new Error('Provider review request was cancelled before start');
    }

    const promptText = buildReviewPrompt(input);

    try {
      // Abort controller promise race for abort handling
      const requestPromise = this.ai.models.generateContent({
        model: this.model,
        contents: promptText,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          maxOutputTokens: this.maxOutputTokens,
        },
      });

      const abortPromise = new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(new Error('Provider review request was aborted'));
        } else {
          signal.addEventListener(
            'abort',
            () => reject(new Error('Provider review request was aborted by timeout or signal')),
            { once: true }
          );
        }
      });

      const response = await Promise.race([requestPromise, abortPromise]);

      const rawText = response.text || '';
      const cleanJson = this.cleanJsonString(rawText);

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(cleanJson);
      } catch {
        throw new Error('Provider returned malformed JSON response');
      }

      const validated = ProviderResponseSchema.safeParse(parsedJson);
      if (!validated.success) {
        throw new Error(
          `Provider response does not match findings schema: ${validated.error.issues.map((i) => i.message).join(', ')}`
        );
      }

      const inputTokens = response.usageMetadata?.promptTokenCount;
      const outputTokens = response.usageMetadata?.candidatesTokenCount;

      return {
        summary: validated.data.summary,
        findings: validated.data.findings as Finding[],
        usage: {
          inputTokens,
          outputTokens,
        },
      };
    } catch (err: unknown) {
      throw this.sanitizeError(err);
    }
  }

  private cleanJsonString(raw: string): string {
    let text = raw.trim();
    if (text.startsWith('```json')) {
      text = text.slice(7);
    } else if (text.startsWith('```')) {
      text = text.slice(3);
    }
    if (text.endsWith('```')) {
      text = text.slice(0, -3);
    }
    return text.trim();
  }

  private sanitizeError(err: unknown): Error {
    if (err instanceof Error) {
      const msg = err.message
        // Redact any potential API key leak
        .replace(/AIza[0-9A-Za-z\\-_]{35}/g, '[REDACTED_KEY]')
        // Redact authorization headers or bearer tokens
        .replace(/key=[^\s&]+/g, 'key=[REDACTED]');

      // Map common status codes cleanly
      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
        return new Error('Gemini API error: Rate limit or quota exceeded (HTTP 429)');
      }
      if (msg.includes('401') || msg.includes('UNAUTHENTICATED')) {
        return new Error('Gemini API error: Authentication failed / invalid API key (HTTP 401)');
      }
      if (msg.includes('403') || msg.includes('PERMISSION_DENIED')) {
        return new Error('Gemini API error: Access forbidden / permission denied (HTTP 403)');
      }

      return new Error(`Gemini provider error: ${msg}`);
    }
    return new Error('Gemini provider encountered an unknown error');
  }
}
