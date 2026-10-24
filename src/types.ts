export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface Finding {
  path: string;
  line: number; // Positive line number on the added/right side of this diff
  severity: Severity;
  message: string;
  recommendation: string;
}

export interface ReviewInput {
  files: ReadonlyArray<{ path: string; patch: string }>;
  maxFindings: number;
  language: string;
  customInstructions?: string;
}

export interface ProviderResult {
  summary?: string;
  findings: Finding[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface AIProvider {
  readonly name: string;
  review(input: ReviewInput, signal: AbortSignal): Promise<ProviderResult>;
}

export type ReviewStatus = 'completed' | 'partial' | 'skipped' | 'failed';

export interface ReviewOutcome {
  status: ReviewStatus;
  reasonCode?: string;
  reviewedFiles: number;
  publishedFindings: number;
  inputTokens?: number;
  outputTokens?: number;
  summary?: string;
}

export interface ParsedPatchFile {
  path: string;
  status: 'added' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged' | 'removed';
  previousPath?: string;
  patch: string;
  addedLines: Set<number>;
  hunkCount: number;
  byteLength: number;
}

export interface DiffSnapshot {
  baseSha: string;
  headSha: string;
  files: ParsedPatchFile[];
  totalFilesCount: number;
  isComplete: boolean;
}

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface Config {
  githubToken: string;
  provider: string;
  model: string;
  providerApiKey: string;
  providerBaseUrl: string;
  allowExternalProvider: boolean;
  maxFiles: number;
  maxFileBytes: number;
  maxInputBytes: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRequests: number;
  maxFindings: number;
  reviewLanguage: string;
  excludePatterns: string[];
  mode: 'comment';
  staticReportPaths: string[];
  failOnError: boolean;
  thinkingLevel: ThinkingLevel;
  customInstructions?: string;
}
