import { describe, expect, it } from 'vitest';
import { parseUnifiedPatch } from '../src/github/diff.js';
import {
  BUGGY_PATCH,
  CLEAN_PATCH,
  MALFORMED_HUNK_PATCH,
  MULTI_HUNK_PATCH,
  NO_NEWLINE_PATCH,
} from './fixtures/patches.js';

describe('Diff and patch parser', () => {
  it('parses single hunk and extracts added line numbers', () => {
    const res = parseUnifiedPatch('src/math.ts', CLEAN_PATCH);
    expect(res.success).toBe(true);
    expect(res.parsed).toBeDefined();
    expect(res.parsed?.hunkCount).toBe(1);
    expect(res.parsed?.path).toBe('src/math.ts');

    // Lines added in CLEAN_PATCH start at 10:
    // line 10: return a + b; (context)
    // line 11: } (context)
    // line 12: export function multiply... (+)
    // line 13:   return a * b; (+)
    // line 14: } (context)
    expect(res.parsed?.addedLines.has(12)).toBe(true);
    expect(res.parsed?.addedLines.has(13)).toBe(true);
    expect(res.parsed?.addedLines.has(10)).toBe(false); // context line
    expect(res.parsed?.addedLines.has(11)).toBe(false); // context line
  });

  it('parses multi-hunk patch', () => {
    const res = parseUnifiedPatch('src/version.ts', MULTI_HUNK_PATCH);
    expect(res.success).toBe(true);
    expect(res.parsed?.hunkCount).toBe(2);
    expect(res.parsed?.addedLines.has(2)).toBe(true);
    expect(res.parsed?.addedLines.has(22)).toBe(true);
    expect(res.parsed?.addedLines.has(23)).toBe(true);
    expect(res.parsed?.addedLines.has(24)).toBe(false);
  });

  it('handles deletions and additions in hunk correctly', () => {
    const res = parseUnifiedPatch('src/user.ts', BUGGY_PATCH);
    expect(res.success).toBe(true);
    // BUGGY_PATCH header: @@ -1,5 +1,8 @@
    // line 1 context: function processUser...
    // line 2 addition: // Seeded bug... (+)
    // line 3 addition: const email = ... (+)
    // line 4 addition: return { id... (+)
    // line 5 context: }
    expect(res.parsed?.addedLines.has(2)).toBe(true);
    expect(res.parsed?.addedLines.has(3)).toBe(true);
    expect(res.parsed?.addedLines.has(4)).toBe(true);
    expect(res.parsed?.addedLines.has(1)).toBe(false);
  });

  it('parses patches with no newline at end of file', () => {
    const res = parseUnifiedPatch('src/text.txt', NO_NEWLINE_PATCH);
    expect(res.success).toBe(true);
    expect(res.parsed?.addedLines.has(2)).toBe(true);
  });

  it('rejects malformed hunks where line counts fail reconciliation', () => {
    const res = parseUnifiedPatch('src/broken.ts', MALFORMED_HUNK_PATCH);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/mismatch/i);
  });

  it('rejects empty or invalid patches', () => {
    expect(parseUnifiedPatch('empty.ts', '').success).toBe(false);
    expect(parseUnifiedPatch('header-only.ts', 'diff --git a/a b/b\nindex 123..456\n').success).toBe(false);
  });
});

describe('Patch parser regression cases', () => {
  it('rejects wrong old-side counts even when the new count matches', () => {
    expect(parseUnifiedPatch('a.ts', '@@ -1,8 +1,1 @@\n-old\n+new').success).toBe(false);
  });
  it('handles a trailing newline without inventing a context line', () => {
    expect(parseUnifiedPatch('a.ts', '@@ -0,0 +1,1 @@\n+new\n').success).toBe(true);
  });
  it('enforces zero-line hunks and rejects unknown prefixes', () => {
    expect(parseUnifiedPatch('a.ts', '@@ -1,1 +1,0 @@\n-old\n+extra').success).toBe(false);
    expect(parseUnifiedPatch('a.ts', '@@ -0,0 +1,1 @@\nINVALID\n+new').success).toBe(false);
  });
});
