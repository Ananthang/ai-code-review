import { ParsedPatchFile } from '../types.js';

export interface BudgetConfig {
  maxFiles: number;
  maxFileBytes: number;
  maxInputBytes: number;
  maxInputTokens: number;
}

export interface BudgetResult {
  includedFiles: ParsedPatchFile[];
  skippedFiles: Array<{ path: string; reason: string }>;
  totalBytes: number;
  estimatedTokens: number;
}

/**
 * Estimates token count conservatively from character/byte count.
 * ~3.5 bytes per token is a safe conservative estimate for code & diffs.
 */
export function estimateTokens(byteLength: number): number {
  return Math.ceil(byteLength / 3.5);
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

    // 3. Check total serialized input budget
    if (currentBytes + file.byteLength > config.maxInputBytes) {
      skippedFiles.push({
        path: file.path,
        reason: `total_input_bytes_exceeded (${currentBytes + file.byteLength} > ${config.maxInputBytes})`,
      });
      continue;
    }

    // 4. Check estimated input tokens guard
    const prospectiveTokens = estimateTokens(currentBytes + file.byteLength);
    if (prospectiveTokens > config.maxInputTokens) {
      skippedFiles.push({
        path: file.path,
        reason: `estimated_tokens_exceeded (${prospectiveTokens} > ${config.maxInputTokens})`,
      });
      continue;
    }

    includedFiles.push(file);
    currentBytes += file.byteLength;
  }

  return {
    includedFiles,
    skippedFiles,
    totalBytes: currentBytes,
    estimatedTokens: estimateTokens(currentBytes),
  };
}
