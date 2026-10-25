import { z } from 'zod';
import { isUnsafeReviewOutput } from '../security/ai-guard.js';
import { Finding, ParsedPatchFile, Severity } from '../types.js';

export const FindingSchema = z.object({
  path: z.string().min(1).max(500),
  line: z.number().int().positive(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  message: z.string().min(1).max(2000),
  recommendation: z.string().min(1).max(2000),
  evidence: z.string().min(1).max(1000).optional(),
  verification: z.string().min(1).max(1000).optional(),
}).strict().refine((finding) => !isUnsafeReviewOutput(
  finding.message + '\n' +
  finding.recommendation + '\n' +
  (finding.evidence ?? '') + '\n' +
  (finding.verification ?? '')
), { message: 'AI guard rejected unsafe or off-task output' });

export const ProviderResponseSchema = z.object({
  summary: z.string().max(4000).optional(),
  findings: z.array(FindingSchema).max(50),
}).strict().refine((response) => !response.summary || !isUnsafeReviewOutput(response.summary), { message: 'AI guard rejected unsafe summary' });

/**
 * Strips code fences and executable suggestion blocks to enforce
 * plain-language remediation instructions without executable code patches.
 */
export function stripExecutableCodeBlocks(text: string): string {
  if (!text) return '';
  return text
    .replace(/```(?:suggestion|diff|[a-z0-9_-]+)?\s*[\r\n]+([\s\S]*?)```/gi, '$1')
    .replace(/```/g, '')
    .trim();
}

/**
 * Neutralizes @ mentions and dangerous HTML in AI-generated strings
 * to prevent accidental notifications or script injection.
 */
export function sanitizeFindingContent(text: string): string {
  if (!text) return '';

  return text
    // Remove URL schemes/autolinks and disable Markdown links, images and tables.
    .replace(/(?:https?|ftp):\/\/[^\s<>]+/gi, '[external URL removed]')
    .replace(/www\.[^\s<>]+/gi, '[external URL removed]')
    .replace(/[\[\]`|]/g, (char) => `&#${char.charCodeAt(0)};`)
    // Neutralize GitHub mentions: @name -> @`name` or @\u200Bname
    .replace(/@([a-zA-Z0-9_\-]+)/g, '@\u200B$1')
    // Escape angle brackets to prevent raw HTML rendering
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Disallow javascript: or vbscript: links
    .replace(/javascript:/gi, 'blocked-scheme:')
    .replace(/vbscript:/gi, 'blocked-scheme:');
}

export interface ValidationContext {
  filePatchMap: Map<string, ParsedPatchFile>;
  minSeverity?: Severity;
  requireEvidence?: boolean;
}

export interface ValidatedFindingsResult {
  validFindings: Finding[];
  droppedFindings: Array<{ finding: unknown; reason: string }>;
}

export function validateAndFilterFindings(
  rawFindings: unknown[],
  context: ValidationContext
): ValidatedFindingsResult {
  const validFindings: Finding[] = [];
  const droppedFindings: Array<{ finding: unknown; reason: string }> = [];

  for (const raw of rawFindings) {
    const parseResult = FindingSchema.safeParse(raw);
    if (!parseResult.success) {
      droppedFindings.push({
        finding: raw,
        reason: `Schema validation failed: ${parseResult.error.issues.map((i) => i.message).join(', ')}`,
      });
      continue;
    }

    const finding = parseResult.data;
    const filePatch = context.filePatchMap.get(finding.path);

    if (!filePatch) {
      droppedFindings.push({
        finding,
        reason: `File '${finding.path}' was not in the reviewed file set`,
      });
      continue;
    }

    const matchedLine = finding.line;
    if (!filePatch.addedLines.has(matchedLine)) {
      droppedFindings.push({
        finding,
        reason: `Line ${finding.line} in '${finding.path}' is not an eligible added line in this diff`,
      });
      continue;
    }

    const ranks: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };
    if (ranks[finding.severity] < ranks[context.minSeverity ?? 'low']) continue;
    if (context.requireEvidence && (!finding.evidence?.trim() ||
        addedSourceLine(filePatch.patch, finding.line) !== finding.evidence)) {
      droppedFindings.push({ finding, reason: 'Missing or unsupported added-line evidence' });
      continue;
    }

    // Sanitize and enforce plain-language suggestions (no executable code blocks)
    validFindings.push({
      path: filePatch.path,
      line: matchedLine,
      severity: finding.severity as Severity,
      message: sanitizeFindingContent(finding.message),
      recommendation: sanitizeFindingContent(stripExecutableCodeBlocks(finding.recommendation)),
      evidence: finding.evidence ? sanitizeFindingContent(finding.evidence) : undefined,
      verification: finding.verification ? sanitizeFindingContent(finding.verification) : undefined,
    });
  }

  return { validFindings, droppedFindings };
}

function addedSourceLine(patch: string, target: number): string | undefined {
  let right = 0;
  for (const line of patch.split('\n')) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { right = Number(hunk[1]); continue; }
    if (line.startsWith('+')) {
      if (right === target) return line.slice(1);
      right++;
    } else if (line.startsWith(' ')) right++;
  }
  return undefined;
}
