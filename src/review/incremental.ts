import { createHash } from 'node:crypto';
import { ExistingIssueComment } from '../github/client.js';
import { Config, ParsedPatchFile } from '../types.js';

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function reviewPolicyKey(config: Config, baseSha: string, context: unknown): string {
  const { githubToken, providerApiKey, ...policy } = config;
  return digest({ version: 1, policy, baseSha, context });
}
export function fileKey(file: ParsedPatchFile): string {
  return digest([file.path, file.status, file.previousPath, file.patch]);
}
export function readCheckpoint(comments: ExistingIssueComment[], policy: string): Set<string> {
  for (const comment of [...comments].reverse()) {
    if (comment.user?.login !== 'github-actions[bot]' || comment.body.length > 65000) continue;
    const match = comment.body.match(/<!-- ai-review-state:v1:([a-f0-9]{64}):([a-f0-9,]*) -->/);
    if (!match || match[1] !== policy) continue;
    const keys = match[2].split(',');
    if (keys.length <= 100 && keys.every(key => /^[a-f0-9]{64}$/.test(key))) return new Set(keys);
  }
  return new Set();
}
export function checkpointMarker(policy: string, keys: Iterable<string>): string {
  return `<!-- ai-review-state:v1:${policy}:${[...new Set(keys)].slice(-100).join(',')} -->`;
}
