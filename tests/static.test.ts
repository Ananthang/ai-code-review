import path from 'path';
import { describe, expect, it } from 'vitest';
import { ingestStaticReports } from '../src/analyzers/static.js';
import { ParsedPatchFile } from '../src/types.js';

describe('Static analysis report ingestion', () => {
  const dummyFile = (filePath: string, addedLines: number[]): ParsedPatchFile => ({
    path: filePath,
    status: 'modified',
    patch: '+test',
    addedLines: new Set(addedLines),
    hunkCount: 1,
    byteLength: 50,
  });

  const fixturesDir = path.resolve(__dirname, 'fixtures/static');

  it('ingests ESLint JSON report and maps only to added lines', () => {
    const filePatchMap = new Map<string, ParsedPatchFile>([
      ['src/user.ts', dummyFile('src/user.ts', [3, 4, 5])],
    ]);

    const result = ingestStaticReports({
      reportPaths: [path.join(fixturesDir, 'eslint.json')],
      expectedHeadSha: 'commit123',
      filePatchMap,
    });

    expect(result.processedReports).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].path).toBe('src/user.ts');
    expect(result.findings[0].line).toBe(3);
    expect(result.findings[0].severity).toBe('high');
    expect(result.findings[0].message).toContain('[ESLint: no-unused-vars]');
  });

  it('ingests RuboCop JSON report', () => {
    const filePatchMap = new Map<string, ParsedPatchFile>([
      ['app/models/user.rb', dummyFile('app/models/user.rb', [15])],
    ]);

    const result = ingestStaticReports({
      reportPaths: [path.join(fixturesDir, 'rubocop.json')],
      expectedHeadSha: 'commit123',
      filePatchMap,
    });

    expect(result.processedReports).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].path).toBe('app/models/user.rb');
    expect(result.findings[0].line).toBe(15);
    expect(result.findings[0].message).toContain('[RuboCop: Rails/FindBy]');
  });

  it('ingests Brakeman JSON report', () => {
    const filePatchMap = new Map<string, ParsedPatchFile>([
      ['app/controllers/posts_controller.rb', dummyFile('app/controllers/posts_controller.rb', [28])],
    ]);

    const result = ingestStaticReports({
      reportPaths: [path.join(fixturesDir, 'brakeman.json')],
      expectedHeadSha: 'commit123',
      filePatchMap,
    });

    expect(result.processedReports).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('medium');
    expect(result.findings[0].line).toBe(28);
  });

  it('ingests Checkov JSON report', () => {
    const filePatchMap = new Map<string, ParsedPatchFile>([
      ['terraform/s3.tf', dummyFile('terraform/s3.tf', [12])],
    ]);

    const result = ingestStaticReports({
      reportPaths: [path.join(fixturesDir, 'checkov.json')],
      expectedHeadSha: 'commit123',
      filePatchMap,
    });

    expect(result.processedReports).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].path).toBe('terraform/s3.tf');
    expect(result.findings[0].line).toBe(12);
  });

  it('ingests SARIF JSON report', () => {
    const filePatchMap = new Map<string, ParsedPatchFile>([
      ['src/crypto.ts', dummyFile('src/crypto.ts', [45])],
    ]);

    const result = ingestStaticReports({
      reportPaths: [path.join(fixturesDir, 'sarif.json')],
      expectedHeadSha: 'commit123',
      filePatchMap,
    });

    expect(result.processedReports).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].path).toBe('src/crypto.ts');
    expect(result.findings[0].line).toBe(45);
    expect(result.findings[0].severity).toBe('high');
  });

  it('skips non-existent report gracefully without failing', () => {
    const result = ingestStaticReports({
      reportPaths: ['nonexistent.json'],
      expectedHeadSha: 'commit123',
      filePatchMap: new Map(),
    });

    expect(result.processedReports).toBe(0);
    expect(result.skippedReports).toHaveLength(1);
    expect(result.skippedReports[0].reason).toMatch(/File does not exist/);
  });
});
