import { describe, expect, it } from 'vitest';
import { sanitizeFindingContent, validateAndFilterFindings } from '../src/review/validate.js';
import { ParsedPatchFile } from '../src/types.js';

describe('Validation and sanitization of findings', () => {
  const dummyFile: ParsedPatchFile = {
    path: 'src/app.ts',
    status: 'modified',
    patch: '+console.log(1);',
    addedLines: new Set([5, 6, 7]),
    hunkCount: 1,
    byteLength: 20,
  };

  const filePatchMap = new Map<string, ParsedPatchFile>([['src/app.ts', dummyFile]]);

  it('accepts valid finding on an added line', () => {
    const raw = [
      {
        path: 'src/app.ts',
        line: 5,
        severity: 'high',
        message: 'Null pointer dereference',
        recommendation: 'Check object for null before access',
      },
    ];

    const { validFindings, droppedFindings } = validateAndFilterFindings(raw, { filePatchMap });
    expect(validFindings).toHaveLength(1);
    expect(droppedFindings).toHaveLength(0);
    expect(validFindings[0].line).toBe(5);
  });

  it('rejects finding on a line not in addedLines set', () => {
    const raw = [
      {
        path: 'src/app.ts',
        line: 1, // line 1 not in [5, 6, 7]
        severity: 'high',
        message: 'Issue on line 1',
        recommendation: 'Fix it',
      },
    ];

    const { validFindings, droppedFindings } = validateAndFilterFindings(raw, { filePatchMap });
    expect(validFindings).toHaveLength(0);
    expect(droppedFindings).toHaveLength(1);
    expect(droppedFindings[0].reason).toMatch(/not an eligible added line/);
  });

  it('rejects finding on unknown file path', () => {
    const raw = [
      {
        path: 'src/unknown.ts',
        line: 5,
        severity: 'medium',
        message: 'Issue',
        recommendation: 'Fix',
      },
    ];

    const { validFindings, droppedFindings } = validateAndFilterFindings(raw, { filePatchMap });
    expect(validFindings).toHaveLength(0);
    expect(droppedFindings[0].reason).toMatch(/was not in the reviewed file set/);
  });

  it('rejects malformed finding structure (invalid severity or negative line)', () => {
    const raw = [
      {
        path: 'src/app.ts',
        line: -5,
        severity: 'super-critical',
        message: 'Bug',
        recommendation: 'Fix',
      },
    ];

    const { validFindings, droppedFindings } = validateAndFilterFindings(raw, { filePatchMap });
    expect(validFindings).toHaveLength(0);
    expect(droppedFindings[0].reason).toMatch(/Schema validation failed/);
  });

  it('sanitizes user mentions and raw HTML tags', () => {
    const sanitized = sanitizeFindingContent('Hello @octocat, see <script>alert(1)</script> and javascript:void(0)');
    expect(sanitized).not.toContain('@octocat');
    expect(sanitized).toContain('@\u200Boctocat');
    expect(sanitized).not.toContain('<script>');
    expect(sanitized).toContain('&lt;script&gt;');
    expect(sanitized).not.toContain('javascript:');
    expect(sanitized).toContain('blocked-scheme:');
  });
});
