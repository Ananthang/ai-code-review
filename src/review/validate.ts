import { z } from 'zod';
import { Finding, ParsedPatchFile, Severity } from '../types.js';

export const FindingSchema = z.object({
  path: z.string().min(1).max(500),
  line: z.number().int().positive(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  message: z.string().min(1).max(2000),
  recommendation: z.string().min(1).max(2000),
});

export const ProviderResponseSchema = z.object({
  summary: z.string().optional(),
  findings: z.array(FindingSchema),
});

/**
 * Neutralizes @ mentions and dangerous HTML in AI-generated strings
 * to prevent accidental notifications or script injection.
 */
export function sanitizeFindingContent(text: string): string {
  if (!text) return '';

  return text
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

    if (!filePatch.addedLines.has(finding.line)) {
      droppedFindings.push({
        finding,
        reason: `Line ${finding.line} in '${finding.path}' is not an eligible added line in this diff`,
      });
      continue;
    }

    // Sanitize text content
    validFindings.push({
      path: finding.path,
      line: finding.line,
      severity: finding.severity as Severity,
      message: sanitizeFindingContent(finding.message),
      recommendation: sanitizeFindingContent(finding.recommendation),
    });
  }

  return { validFindings, droppedFindings };
}
