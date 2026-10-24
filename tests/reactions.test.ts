import { describe, expect, it, vi } from 'vitest';
import { reactToReviewStart } from '../src/github/reactions.js';
import { GitHubClient, OctokitGitHubClient, PullRequestDetails } from '../src/github/client.js';
import { SUMMARY_MARKER } from '../src/review/dedupe.js';

const pr = { eventName: 'pull_request', pullNumber: 42 } as PullRequestDetails;
function clientWith(comments: unknown[] = []) {
  return {
    fetchIssueComments: vi.fn().mockResolvedValue(comments),
    addCommentReaction: vi.fn().mockResolvedValue(undefined),
    addPullRequestReaction: vi.fn().mockResolvedValue(undefined),
  };
}
describe('Review-start reactions', () => {
  it('reacts to the triggering comment rather than the PR description', async () => {
    const client = clientWith();
    await reactToReviewStart(client as unknown as GitHubClient, { ...pr, eventName: 'issue_comment', commentId: 123 });
    expect(client.addCommentReaction).toHaveBeenCalledWith(123, 'eyes');
    expect(client.addPullRequestReaction).not.toHaveBeenCalled();
    expect(client.fetchIssueComments).not.toHaveBeenCalled();
  });
  it('reacts to the PR description on its first automatic review', async () => {
    const client = clientWith();
    await reactToReviewStart(client as unknown as GitHubClient, pr);
    expect(client.addPullRequestReaction).toHaveBeenCalledWith(42, 'eyes');
  });
  it('does not add a new PR reaction after a bot review summary exists', async () => {
    const client = clientWith([{ body: SUMMARY_MARKER, user: { login: 'github-actions[bot]' } }]);
    await reactToReviewStart(client as unknown as GitHubClient, pr);
    expect(client.addPullRequestReaction).not.toHaveBeenCalled();
  });
  it('does not treat a human summary marker as an earlier review', async () => {
    const client = clientWith([{ body: SUMMARY_MARKER, user: { login: 'human' } }]);
    await reactToReviewStart(client as unknown as GitHubClient, pr);
    expect(client.addPullRequestReaction).toHaveBeenCalledOnce();
  });
  it('does not fail review when reaction permissions are denied', async () => {
    const client = clientWith(); client.addPullRequestReaction.mockRejectedValue(new Error('403'));
    await expect(reactToReviewStart(client as unknown as GitHubClient, pr)).resolves.toBeUndefined();
  });
  it('uses the issue reaction API for the PR description', async () => {
    const client = new OctokitGitHubClient('test', 'owner', 'repo');
    const createForIssue = vi.fn().mockResolvedValue({});
    (client as any).octokit = { rest: { reactions: { createForIssue } } };
    await client.addPullRequestReaction(42, 'eyes');
    expect(createForIssue).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', issue_number: 42, content: 'eyes' });
  });
});
