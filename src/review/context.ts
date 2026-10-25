import path from 'node:path';
import { GitHubClient } from '../github/client.js';
import { PathExclusionFilter, normalizeRepoPath } from '../security/exclusions.js';
import { hasPromptInjection } from '../security/ai-guard.js';
import { ParsedPatchFile } from '../types.js';

// Static relative imports only. No model-selected paths, package resolution or execution.
export function contextCandidates(files: ParsedPatchFile[]): string[] {
  const candidates = new Set<string>();
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file.path)) continue;
    for (const match of file.patch.matchAll(/(?:from\s*|require\(\s*|import\s*)['"](\.[^'"\s]+)['"]/g)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), match[1]));
      if (normalizeRepoPath(resolved) !== resolved || resolved.split('/').length > 8) continue;
      if (/\.[cm]?[jt]sx?$/.test(resolved)) candidates.add(resolved);
      else if (!path.posix.extname(resolved)) {
        candidates.add(resolved + '.ts'); candidates.add(resolved + '.js');
      }
      if (candidates.size >= 4) break;
    }
    if (candidates.size >= 4) break;
  }
  return [...candidates].filter(p => !files.some(f => f.path === p)).slice(0, 4);
}
export async function collectContext(client: GitHubClient, sha: string, files: ParsedPatchFile[],
  filter: PathExclusionFilter, maxBytes: number): Promise<Array<{ path: string; content: string }>> {
  const result: Array<{ path: string; content: string }> = [];
  if (!client.fetchSourceFile || maxBytes <= 0) return result;
  let remaining = maxBytes;
  for (const candidate of contextCandidates(files)) {
    if (filter.testPath(candidate).excluded || hasPromptInjection(candidate)) continue;
    try {
      const content = await client.fetchSourceFile(candidate, sha, remaining);
      if (!content || Buffer.byteLength(content) > remaining || content.includes('\0') ||
          hasPromptInjection(content) || filter.testPatchContent(content).hasMarker) continue;
      result.push({ path: candidate, content });
      remaining -= Buffer.byteLength(content);
      if (result.length >= 2 || remaining <= 0) break;
    } catch { /* Optional context is omitted on read failure. */ }
  }
  return result;
}
