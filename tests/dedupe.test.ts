import { describe, expect, it } from 'vitest';
import {
  computeFindingFingerprint,
  extractFingerprintFromComment,
  isSummaryComment,
  SUMMARY_MARKER,
} from '../src/review/dedupe.js';
import { formatFindingComment } from '../src/github/comments.js';
import { Finding } from '../src/types.js';

describe('Deduplication and fingerprinting', () => {
  const finding: Finding = {
    path: 'src/auth.ts',
    line: 42,
    severity: 'high',
    message: 'Hardcoded secret token used',
    recommendation: 'Use process.env.API_KEY instead',
  };

  it('generates consistent fingerprint regardless of minor whitespace or casing in message', () => {
    const fp1 = computeFindingFingerprint('owner/repo', 12, finding);

    const rewordedFinding: Finding = {
      ...finding,
      message: 'hardcoded secret token used   ',
    };
    const fp2 = computeFindingFingerprint('owner/repo', 12, rewordedFinding);

    expect(fp1).toBe(fp2);
  });

  it('embeds fingerprint in comment and extracts it cleanly', () => {
    const fp = computeFindingFingerprint('owner/repo', 12, finding);
    const commentBody = formatFindingComment(finding, fp);

    expect(commentBody).toContain(`<!-- ai-code-review-fingerprint:v1:${fp} -->`);

    const extracted = extractFingerprintFromComment(commentBody);
    expect(extracted).toBe(fp);
  });

  it('detects summary comments', () => {
    expect(isSummaryComment(`## Summary\n\n${SUMMARY_MARKER}`)).toBe(true);
    expect(isSummaryComment('## Normal Comment without marker')).toBe(false);
  });
});
