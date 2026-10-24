import fs from 'fs';
import path from 'path';
import { Finding, ParsedPatchFile, Severity } from '../types.js';
import { normalizeRepoPath } from '../security/exclusions.js';

export const MAX_REPORT_FILE_BYTES = 5 * 1024 * 1024; // 5 MB max per report file
export const MAX_REPORT_RECORDS = 500; // max items to inspect from a report

export interface IngestStaticReportsOptions {
  reportPaths: string[];
  expectedHeadSha: string;
  filePatchMap: Map<string, ParsedPatchFile>;
}

export interface StaticReportIngestResult {
  findings: Finding[];
  processedReports: number;
  skippedReports: Array<{ path: string; reason: string }>;
}

export function parseSeverity(level: string | number | undefined): Severity {
  if (typeof level === 'number') {
    // ESLint: 2 = error, 1 = warning
    if (level >= 2) return 'high';
    return 'medium';
  }
  if (!level) return 'medium';

  const lower = level.toString().toLowerCase();
  if (lower.includes('critical')) {
    return 'critical';
  }
  if (lower.includes('error') || lower.includes('fatal') || lower.includes('high')) {
    return 'high';
  }
  if (lower.includes('warn') || lower.includes('warning') || lower.includes('medium')) {
    return 'medium';
  }
  return 'low';
}

/**
 * Ingests external static analysis JSON reports safely.
 * Only lines on the eligible added-lines diff are retained.
 */
export function ingestStaticReports(options: IngestStaticReportsOptions): StaticReportIngestResult {
  const allFindings: Finding[] = [];
  const skippedReports: Array<{ path: string; reason: string }> = [];
  let processedReports = 0;

  for (const reportPath of options.reportPaths) {
    if (!fs.existsSync(reportPath)) {
      skippedReports.push({ path: reportPath, reason: 'File does not exist' });
      continue;
    }

    const stat = fs.statSync(reportPath);
    if (stat.size > MAX_REPORT_FILE_BYTES) {
      skippedReports.push({
        path: reportPath,
        reason: `Report exceeds maximum file size (${stat.size} > ${MAX_REPORT_FILE_BYTES} bytes)`,
      });
      continue;
    }

    let parsed: any;
    try {
      const content = fs.readFileSync(reportPath, 'utf8');
      parsed = JSON.parse(content);
    } catch {
      skippedReports.push({ path: reportPath, reason: 'Malformed JSON report' });
      continue;
    }

    // Optional provenance / SHA check: if report has head_sha or metadata.headSha, it must match
    const reportSha = parsed.head_sha || parsed.headSha || parsed.metadata?.head_sha || parsed.metadata?.headSha;
    if (reportSha && reportSha !== options.expectedHeadSha) {
      skippedReports.push({
        path: reportPath,
        reason: `Report head SHA mismatch (expected ${options.expectedHeadSha.slice(0, 7)}, got ${String(reportSha).slice(0, 7)})`,
      });
      continue;
    }

    const reportFindings = extractFindingsFromReport(parsed, options.filePatchMap);
    allFindings.push(...reportFindings);
    processedReports++;
  }

  return {
    findings: allFindings,
    processedReports,
    skippedReports,
  };
}

/**
 * Extracts and normalizes findings from supported static analyzer formats:
 * - ESLint JSON
 * - RuboCop JSON
 * - Brakeman JSON
 * - Checkov JSON
 * - SARIF JSON
 */
export function extractFindingsFromReport(
  data: any,
  filePatchMap: Map<string, ParsedPatchFile>
): Finding[] {
  const findings: Finding[] = [];

  // Helper to add finding if it maps to an added line
  const maybeAdd = (filePath: string, line: number, severity: Severity, message: string, rec: string) => {
    let cleanPath = normalizeRepoPath(filePath);
    if (!cleanPath) return;

    // Find matching patch file by exact or relative path match
    let patchFile = filePatchMap.get(cleanPath);
    if (!patchFile) {
      for (const [p, pf] of filePatchMap.entries()) {
        if (cleanPath.endsWith(p) || p.endsWith(cleanPath)) {
          patchFile = pf;
          cleanPath = p;
          break;
        }
      }
    }

    if (!patchFile) return;
    if (!patchFile.addedLines.has(line)) return;

    findings.push({
      path: cleanPath,
      line,
      severity,
      message,
      recommendation: rec,
    });
  };

  // 1. ESLint JSON format: [ { filePath: "...", messages: [ { line, ruleId, message, severity } ] } ]
  if (Array.isArray(data) && data.length > 0 && data[0]?.messages && data[0]?.filePath) {
    for (const fileItem of data.slice(0, MAX_REPORT_RECORDS)) {
      const relPath = path.relative(process.cwd(), fileItem.filePath) || fileItem.filePath;
      for (const msg of fileItem.messages || []) {
        if (typeof msg.line === 'number' && msg.line > 0) {
          maybeAdd(
            relPath,
            msg.line,
            parseSeverity(msg.severity),
            `[ESLint: ${msg.ruleId || 'syntax'}] ${msg.message}`,
            `Review and satisfy ESLint rule '${msg.ruleId || 'syntax'}'.`
          );
        }
      }
    }
    return findings;
  }

  // 2. RuboCop JSON format: { files: [ { path: "...", offenses: [ { location: { line }, message, severity, cop_name } ] } ] }
  if (data?.files && Array.isArray(data.files)) {
    for (const fileItem of data.files.slice(0, MAX_REPORT_RECORDS)) {
      for (const offense of fileItem.offenses || []) {
        const line = offense.location?.line || offense.location?.start_line;
        if (typeof line === 'number' && line > 0) {
          maybeAdd(
            fileItem.path,
            line,
            parseSeverity(offense.severity),
            `[RuboCop: ${offense.cop_name}] ${offense.message}`,
            `Satisfy RuboCop rule '${offense.cop_name}'.`
          );
        }
      }
    }
    return findings;
  }

  // 3. Brakeman JSON format: { warnings: [ { line, file, warning_type, message, confidence } ] }
  if (data?.warnings && Array.isArray(data.warnings)) {
    for (const warn of data.warnings.slice(0, MAX_REPORT_RECORDS)) {
      if (typeof warn.line === 'number' && warn.line > 0 && warn.file) {
        maybeAdd(
          warn.file,
          warn.line,
          parseSeverity(warn.confidence === 'High' ? 'critical' : warn.confidence === 'Medium' ? 'high' : 'medium'),
          `[Brakeman: ${warn.warning_type}] ${warn.message}`,
          `Review security recommendation for ${warn.warning_type}.`
        );
      }
    }
    return findings;
  }

  // 4. Checkov JSON format: { results: { failed_checks: [ { file_path, file_line_range, check_name, check_id } ] } }
  if (data?.results?.failed_checks && Array.isArray(data.results.failed_checks)) {
    for (const check of data.results.failed_checks.slice(0, MAX_REPORT_RECORDS)) {
      const line = Array.isArray(check.file_line_range) ? check.file_line_range[0] : 1;
      const cleanPath = (check.file_path || '').replace(/^\//, '');
      if (typeof line === 'number' && line > 0 && cleanPath) {
        maybeAdd(
          cleanPath,
          line,
          'high',
          `[Checkov: ${check.check_id}] ${check.check_name}`,
          `Address configuration check ${check.check_id}.`
        );
      }
    }
    return findings;
  }

  // 5. SARIF JSON format: { runs: [ { results: [ ... ] } ] }
  if (data?.runs && Array.isArray(data.runs)) {
    for (const run of data.runs) {
      const results = run.results || [];
      for (const res of results.slice(0, MAX_REPORT_RECORDS)) {
        const loc = res.locations?.[0]?.physicalLocation;
        const uri = loc?.artifactLocation?.uri;
        const line = loc?.region?.startLine;
        const msg = res.message?.text || 'SARIF alert';
        const ruleId = res.ruleId || 'static-rule';
        if (uri && typeof line === 'number' && line > 0) {
          maybeAdd(
            uri,
            line,
            parseSeverity(res.level),
            `[${ruleId}] ${msg}`,
            `Satisfy static analysis rule '${ruleId}'.`
          );
        }
      }
    }
    return findings;
  }

  return findings;
}
