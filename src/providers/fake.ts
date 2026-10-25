import { AIProvider, Finding, ProviderResult, ReviewInput } from '../types.js';

export interface FakeProviderOptions {
  summary?: string;
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

    if (input.threadContext && !this.options.summary) {
      return {
        summary: `Explanation: This finding was reported because ${input.threadContext.originalFinding ? 'the flagged code represents a potential defect or production issue' : 'the code should be reviewed'}.`,
        findings: [],
        usage: {
          inputTokens: 150,
          outputTokens: 75,
        },
      };
    }

    const findings = this.options.findings ?? [];
    return {
      summary: this.options.summary,
      findings: findings.slice(0, input.maxFindings),
      usage: {
        inputTokens: 150,
        outputTokens: 75,
      },
    };
  }
}
