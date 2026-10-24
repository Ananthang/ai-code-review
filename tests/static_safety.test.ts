import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ingestStaticReports } from '../src/analyzers/static.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function ingest(data: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-static-')); dirs.push(dir);
  const file = path.join(dir, 'report.json'); fs.writeFileSync(file, JSON.stringify(data));
  return ingestStaticReports({ reportPaths: [file], expectedHeadSha: 'head', filePatchMap: new Map([
    ['src/a.ts', { path: 'src/a.ts', patch: '+bad', status: 'added', addedLines: new Set([1]), hunkCount: 1, byteLength: 4 }],
  ]) });
}
const report = [{ filePath: 'src/a.ts', messages: [{ line: 1, message: 'bug', severity: 2 }] }];
describe('Static report trust checks', () => {
  it('rejects absent and stale SHA wrappers', () => {
    expect(ingest(report).processedReports).toBe(0);
    expect(ingest({ headSha: 'stale', report }).processedReports).toBe(0);
    expect(ingest({ headSha: 'head', report }).findings).toHaveLength(1);
  });
  it('does not suffix-match an unrelated path', () => {
    expect(ingest({ headSha: 'head', report: [{ ...report[0], filePath: 'other/src/a.ts' }] }).findings).toHaveLength(0);
  });
  it('skips malformed nested structures without crashing review', () => {
    const result = ingest({ headSha: 'head', report: [{ ...report[0], messages: 42 }] });
    expect(result.processedReports).toBe(0);
    expect(result.skippedReports).toHaveLength(1);
  });
  it('bounds nested record counts', () => {
    const result = ingest({ headSha: 'head', report: [{ ...report[0], messages: Array(501).fill(report[0].messages[0]) }] });
    expect(result.processedReports).toBe(0);
    expect(result.skippedReports[0].reason).toContain('limit');
  });
});
