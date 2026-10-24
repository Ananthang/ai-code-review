import { describe, expect, it } from 'vitest';
import { budgetFiles, estimateTokens } from '../src/review/budget.js';
import { ParsedPatchFile } from '../src/types.js';

describe('Budget selection & token estimation', () => {
  const createFile = (path: string, byteLength: number): ParsedPatchFile => ({
    path,
    status: 'modified',
    patch: 'a'.repeat(byteLength),
    addedLines: new Set([1]),
    hunkCount: 1,
    byteLength,
  });

  it('estimates tokens conservatively', () => {
    expect(estimateTokens(350)).toBe(350);
    expect(estimateTokens(35)).toBe(35);
  });

  it('sorts files deterministically by path', () => {
    const files = [
      createFile('z_service.ts', 100),
      createFile('a_controller.ts', 100),
      createFile('m_middleware.ts', 100),
    ];

    const res = budgetFiles(files, {
      maxFiles: 10,
      maxFileBytes: 1000,
      maxInputBytes: 1000,
      maxInputTokens: 1000,
    });

    expect(res.includedFiles.map((f) => f.path)).toEqual([
      'a_controller.ts',
      'm_middleware.ts',
      'z_service.ts',
    ]);
  });

  it('enforces maxFiles limit', () => {
    const files = [
      createFile('f1.ts', 100),
      createFile('f2.ts', 100),
      createFile('f3.ts', 100),
    ];

    const res = budgetFiles(files, {
      maxFiles: 2,
      maxFileBytes: 1000,
      maxInputBytes: 1000,
      maxInputTokens: 1000,
    });

    expect(res.includedFiles.length).toBe(2);
    expect(res.skippedFiles).toHaveLength(1);
    expect(res.skippedFiles[0].reason).toBe('max_files_limit_reached');
  });

  it('skips individual oversized files without slicing', () => {
    const files = [
      createFile('small.ts', 500),
      createFile('oversized.ts', 25000), // > 20480
    ];

    const res = budgetFiles(files, {
      maxFiles: 10,
      maxFileBytes: 20480,
      maxInputBytes: 81920,
      maxInputTokens: 24000,
    });

    expect(res.includedFiles.map((f) => f.path)).toEqual(['small.ts']);
    expect(res.skippedFiles[0].path).toBe('oversized.ts');
  });

  it('enforces total input bytes limit', () => {
    const files = [
      createFile('f1.ts', 600),
      createFile('f2.ts', 600),
    ];

    const res = budgetFiles(files, {
      maxFiles: 10,
      maxFileBytes: 1000,
      maxInputBytes: 1000,
      maxInputTokens: 1000,
    });

    expect(res.includedFiles.length).toBe(1);
    expect(res.skippedFiles[0].reason).toMatch(/total_input_bytes_exceeded/);
  });
});
