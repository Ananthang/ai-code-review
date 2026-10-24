import { ParsedPatchFile, ReviewInput } from '../types.js';

export interface BudgetConfig {
  maxFiles: number;
  maxFileBytes: number;
  maxInputBytes: number;
  maxInputTokens: number;
  measureInput?: (files: ReviewInput['files']) => number;
}

export interface BudgetResult {
  includedFiles: ParsedPatchFile[];
  skippedFiles: Array<{ path: string; reason: string }>;
  totalBytes: number;
  estimatedTokens: number;
}

/**
 * Estimates token count conservatively from character/byte count.
 * One token per UTF-8 byte is an intentionally conservative guard, not billing usage.
 */
export function estimateTokens(byteLength: number): number {
  return Math.ceil(byteLength);
}

/**
 * Deterministically budgets and selects whole patch files within size and count constraints.
 * Never cuts a hunk or file partially.
 */
export function budgetFiles(files: ParsedPatchFile[], config: BudgetConfig): BudgetResult {
  // Sort deterministically by file path
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

  const includedFiles: ParsedPatchFile[] = [];
  const skippedFiles: Array<{ path: string; reason: string }> = [];

  let currentBytes = 0;

  for (const file of sorted) {
    // 1. Check maxFiles constraint
    if (includedFiles.length >= config.maxFiles) {
      skippedFiles.push({ path: file.path, reason: 'max_files_limit_reached' });
      continue;
    }

    // 2. Check individual file size limit (whole patch only)
    if (file.byteLength > config.maxFileBytes) {
      skippedFiles.push({
        path: file.path,
        reason: `file_size_exceeds_limit (${file.byteLength} > ${config.maxFileBytes} bytes)`,
      });
      continue;
    }

    const prospectiveBytes = config.measureInput
      ? config.measureInput([...includedFiles, file].map(({ path, patch }) => ({ path, patch })))
      : currentBytes + file.byteLength;

    // 3. Check total serialized input budget
    if (prospectiveBytes > config.maxInputBytes) {
      skippedFiles.push({
        path: file.path,
        reason: `total_input_bytes_exceeded (${currentBytes + file.byteLength} > ${config.maxInputBytes})`,
      });
      continue;
    }

    // 4. Check estimated input tokens guard
    const prospectiveTokens = estimateTokens(prospectiveBytes);
    if (prospectiveTokens > config.maxInputTokens) {
      skippedFiles.push({
        path: file.path,
        reason: `estimated_tokens_exceeded (${prospectiveTokens} > ${config.maxInputTokens})`,
      });
      continue;
    }

    includedFiles.push(file);
    currentBytes = prospectiveBytes;
  }

  return {
    includedFiles,
    skippedFiles,
    totalBytes: currentBytes,
    estimatedTokens: estimateTokens(currentBytes),
  };
}
