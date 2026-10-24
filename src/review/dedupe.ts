import crypto from 'crypto';
import { Finding } from '../types.js';

export const FINGERPRINT_MARKER_REGEX = /<!--\s*ai-code-review-fingerprint:v1:([a-f0-9]{32,64})\s*-->/;
export const SUMMARY_MARKER = '<!-- ai-code-review-summary:v1 -->';

/**
 * Normalizes text for stable fingerprinting:
 * - lowercase
 * - collapses whitespace
 * - removes punctuation
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Computes a stable fingerprint for an inline finding.
 * Excludes commit SHA so unchanged issues across commits / reruns are suppressed.
 */
export function computeFindingFingerprint(
  repoFullName: string,
  pullNumber: number,
  finding: Finding
): string {
  const normalizedExplanation = normalizeText(finding.message);
  const normalizedRecommendation = normalizeText(finding.recommendation);
  const input = `${repoFullName}|${pullNumber}|${finding.path}|${finding.line}|${finding.severity}|${normalizedExplanation}|${normalizedRecommendation}`;

  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Extracts fingerprint from an existing comment body if present.
 */
export function extractFingerprintFromComment(body: string): string | null {
  if (!body) return null;
  const match = body.match(FINGERPRINT_MARKER_REGEX);
  return match ? match[1] : null;
}

/**
 * Checks if comment body contains the summary marker.
 */
export function isSummaryComment(body: string): boolean {
  return typeof body === 'string' && body.includes(SUMMARY_MARKER);
}
