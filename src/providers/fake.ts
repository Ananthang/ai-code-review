import { AIProvider, Finding, ProviderResult, ReviewInput } from '../types.js';

export interface FakeProviderOptions {
  findings?: Finding[];
  delayMs?: number;
  shouldFail?: boolean;
  failureMessage?: string;
}

export class FakeProvider implements AIProvider {
  public readonly name = 'fake';
  private readonly options: FakeProviderOptions;

  constructor(options: FakeProviderOptions = {}) {
    this.options = options;
  }

  public async review(input: ReviewInput, signal: AbortSignal): Promise<ProviderResult> {
    if (signal.aborted) {
      throw new Error('Review aborted by signal');
    }

    if (this.options.delayMs && this.options.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), this.options.delayMs);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Review aborted by signal'));
        });
      });
    }

    if (this.options.shouldFail) {
      throw new Error(this.options.failureMessage || 'Simulated fake provider failure');
    }

    const findings = this.options.findings ?? [];
    return {
      findings: findings.slice(0, input.maxFindings),
      usage: {
        inputTokens: 150,
        outputTokens: 75,
      },
    };
  }
}
