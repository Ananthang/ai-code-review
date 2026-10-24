import { sanitizeFindingContent } from '../review/validate.js';
import { Finding, ReviewOutcome, Severity } from '../types.js';
import {
  computeFindingFingerprint,
  extractFingerprintFromComment,
  isSummaryComment,
  SUMMARY_MARKER,
} from '../review/dedupe.js';
import { GitHubClient, ReviewCommentPayload } from './client.js';

export interface SummaryData {
  status: ReviewOutcome['status'];
  reasonCode?: string;
  model: string;
  provider: string;
  reviewedFiles: number;
  totalChangedFiles: number;
  skippedFilesCount: number;
  excludedReasons: Record<string, number>;
  totalFindingsCount: number;
  novelFindingsCount: number;
  publishedFindingsCount: number;
  dedupedCount: number;
  inputTokens?: number;
  outputTokens?: number;
  overview?: string;
  findingsList?: Finding[];
}

const SEVERITY_ICONS: Record<Severity, string> = {
  critical: '🚨 **Critical**',
  high: '⚠️ **High**',
  medium: '💡 **Medium**',
  low: 'ℹ️ **Low**',
};

const SEVERITY_RANKS: Record<Severity, number> = {
  critical: 1,
  high: 2,
  medium: 3,
  low: 4,
};

export function formatFindingComment(finding: Finding, fingerprint: string): string {
  const badge = SEVERITY_ICONS[finding.severity] || finding.severity.toUpperCase();

  return [
    `### ${badge}`,
    '',
    `**Issue:** ${finding.message}`,
    '',
    `**Recommendation:** ${finding.recommendation}`,
    '',
    `<!-- ai-code-review-fingerprint:v1:${fingerprint} -->`,
  ].join('\n');
}

function cleanMessage(text: string, maxLen = 100): string {
  const singleLine = text.replace(/[\r\n]+/g, ' ').trim();
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.slice(0, maxLen - 3) + '...';
}

export function formatSummaryComment(data: SummaryData): string {
  const statusEmoji = data.status === 'completed' ? '✅' : data.status === 'partial' ? '⚠️' : 'ℹ️';
  const cleanModel = data.model.replace(/^models\//, '');

  const lines: string[] = [
    `## ${statusEmoji} AI Code Review Summary`,
    '',
    `| Status | Provider & Model | Reviewed Files | Findings |`,
    `| :--- | :--- | :--- | :--- |`,
    `| **${data.status.toUpperCase()}${data.reasonCode ? ` (${data.reasonCode})` : ''}** | \`${data.provider}\` / \`${cleanModel}\` | **${data.reviewedFiles}** of ${data.totalChangedFiles} | **${data.publishedFindingsCount}** new (${data.dedupedCount} deduped) |`,
    '',
  ];

  // 1. Overview description
  lines.push('### 📝 Overview of Changes');
  if (data.overview && data.overview.trim()) {
    lines.push(sanitizeFindingContent(data.overview.trim()));
  } else if (data.reviewedFiles === 0) {
    lines.push('No eligible code files were found to review after applying exclusions.');
  } else {
    lines.push(
      `Automated AI review evaluated **${data.reviewedFiles} file(s)** against best practices, security guidelines, and potential defects.`
    );
  }
  lines.push('');

  // 2. Findings table / Verdict
  if (data.findingsList && data.findingsList.length > 0) {
    lines.push('### 🔍 Key Findings & Recommendations');
    lines.push('');
    lines.push('| Severity | Location | Issue | Recommendation |');
    lines.push('| :--- | :--- | :--- | :--- |');

    for (const f of data.findingsList) {
      const badge = SEVERITY_ICONS[f.severity] || f.severity.toUpperCase();
      const loc = `\`${f.path}:${f.line}\``;
      const issue = cleanMessage(f.message, 100);
      const rec = cleanMessage(f.recommendation, 100);
      lines.push(`| ${badge} | ${loc} | ${issue} | ${rec} |`);
    }
    lines.push('');
  } else if (data.status === 'completed' && data.totalFindingsCount === 0) {
    lines.push('### 🟢 Review Verdict: Clean');
    lines.push('No defects, security issues, or regressions were identified in the reviewed changes.');
    lines.push('');
  }

  // 3. Collapsible Coverage & Telemetry Details
  lines.push('<details>');
  lines.push('<summary><b>📊 Review & Exclusions Breakdown</b></summary>');
  lines.push('');
  lines.push(`- **Reviewed Files:** ${data.reviewedFiles} of ${data.totalChangedFiles} total`);
  lines.push(`- **Skipped / Excluded Files:** ${data.skippedFilesCount}`);

  const reasonEntries = Object.entries(data.excludedReasons);
  if (reasonEntries.length > 0) {
    for (const [reason, count] of reasonEntries) {
      lines.push(`  - \`${reason}\`: ${count}`);
    }
  }

  lines.push(`- **Total Detected Issues:** ${data.totalFindingsCount}`);
  lines.push(`- **Previously Commented (Deduped):** ${data.dedupedCount}`);
  lines.push(`- **Newly Published Comments:** ${data.publishedFindingsCount}`);

  if (data.inputTokens !== undefined || data.outputTokens !== undefined) {
    lines.push('');
    lines.push(`- **Estimated Input Tokens:** ${data.inputTokens ?? 0}`);
    lines.push(`- **Output Tokens:** ${data.outputTokens ?? 0}`);
  }

  lines.push('');
  lines.push('</details>');
  lines.push('');

  // 4. Interactive Command Tips
  lines.push('> [!TIP]');
  lines.push('> - Comment `/review` to re-trigger a full review on the latest commit.');
  lines.push('> - Comment `/review <file>` (e.g. `/review path/to/file`) to re-check a specific file.');
  lines.push('');

  // 5. Mandatory Disclaimer
  lines.push('> [!NOTE]');
  lines.push('> This advisory review was generated by a bounded AI action to assist maintainers.');
  lines.push('> It does not certify security, guarantee defect-free code, or replace human review.');
  lines.push('');
  lines.push(SUMMARY_MARKER);

  return lines.join('\n');
}

export function rankFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const rankA = SEVERITY_RANKS[a.severity] ?? 99;
    const rankB = SEVERITY_RANKS[b.severity] ?? 99;
    if (rankA !== rankB) return rankA - rankB;

    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;

    return a.line - b.line;
  });
}

export async function publishFindingsAndSummary(
  client: GitHubClient,
  repoFullName: string,
  pullNumber: number,
  expectedHeadSha: string,
  findings: Finding[],
  summaryData: Omit<SummaryData, 'totalFindingsCount' | 'novelFindingsCount' | 'publishedFindingsCount' | 'dedupedCount'>,
  maxFindings: number
): Promise<{
  publishedCount: number;
  dedupedCount: number;
  staleHead: boolean;
  errors: string[];
}> {
  // 1. Fetch existing review comments to build deduplication set
  const existingComments = await client.fetchReviewComments(pullNumber);
  const existingFingerprints = new Set<string>();

  for (const c of existingComments) {
    if (c.user?.login !== 'github-actions[bot]') continue;
    const fp = extractFingerprintFromComment(c.body);
    if (fp) {
      existingFingerprints.add(fp);
    }
  }

  // 2. Filter novel findings and compute fingerprints
  const novelFindings: Array<{ finding: Finding; fingerprint: string }> = [];
  let dedupedCount = 0;

  for (const finding of findings) {
    const fingerprint = computeFindingFingerprint(repoFullName, pullNumber, finding);
    if (existingFingerprints.has(fingerprint)) {
      dedupedCount++;
    } else {
      existingFingerprints.add(fingerprint);
      novelFindings.push({ finding, fingerprint });
    }
  }

  // 3. Rank novel findings and cap to maxFindings
  const rankedNovel = rankFindings(novelFindings.map((n) => n.finding));
  const cappedFindings = rankedNovel.slice(0, maxFindings);

  const payloadComments: ReviewCommentPayload[] = cappedFindings.map((finding) => {
    const fingerprint = computeFindingFingerprint(repoFullName, pullNumber, finding);
    return {
      path: finding.path,
      line: finding.line,
      body: formatFindingComment(finding, fingerprint),
    };
  });

  // 4. Stale-head check right before publishing (FR-12 & ARCHITECTURE §5)
  const currentHeadSha = await client.getHeadSha(pullNumber);
  if (currentHeadSha !== expectedHeadSha) {
    return {
      publishedCount: 0,
      dedupedCount,
      staleHead: true,
      errors: [`PR head changed from ${expectedHeadSha.slice(0, 7)} to ${currentHeadSha.slice(0, 7)}; review discarded`],
    };
  }

  // 5. Publish review comments
  const publishResult = await client.publishReviewComments(pullNumber, expectedHeadSha, payloadComments);

  // 6. Maintain single summary issue comment
  const existingIssueComments = await client.fetchIssueComments(pullNumber);
  const existingSummary = existingIssueComments.find((c) => c.user?.login === 'github-actions[bot]' && isSummaryComment(c.body));

  const fullSummaryData: SummaryData = {
    ...summaryData,
    ...(publishResult.errors.length ? { status: 'partial' as const, reasonCode: 'publication_incomplete' } : {}),
    totalFindingsCount: findings.length,
    novelFindingsCount: novelFindings.length,
    publishedFindingsCount: publishResult.publishedCount,
    dedupedCount,
    findingsList: cappedFindings,
  };

  const summaryMarkdown = formatSummaryComment(fullSummaryData);
  try {
    await client.createOrUpdateSummary(pullNumber, summaryMarkdown, existingSummary?.id);
  } catch { publishResult.errors.push('summary_publication_failed'); }

  return {
    publishedCount: publishResult.publishedCount,
    dedupedCount,
    staleHead: false,
    errors: publishResult.errors,
  };
}
