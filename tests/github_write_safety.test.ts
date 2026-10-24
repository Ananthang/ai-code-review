import { describe, expect, it, vi } from 'vitest';
import { OctokitGitHubClient } from '../src/github/client.js';

describe('GitHub write safety', () => {
  it('never blindly retries a write after an ambiguous batch failure', async () => {
    const client = new OctokitGitHubClient('test-token', 'owner', 'repo');
    const batch = vi.fn().mockRejectedValue(new Error('PRIVATE_SOURCE: response lost after write'));
    const individual = vi.fn();
    (client as any).octokit = { rest: { pulls: { createReview: batch, createReviewComment: individual } } };
    const result = await client.publishReviewComments(1, 'sha', [{ path: 'a.ts', line: 1, body: 'issue' }]);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(individual).not.toHaveBeenCalled();
    expect(result).toEqual({ publishedCount: 0, errors: ['publication_outcome_unknown'] });
  });
});
