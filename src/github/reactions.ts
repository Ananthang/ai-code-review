import { GitHubClient, PullRequestDetails } from './client.js';
import { isSummaryComment } from '../review/dedupe.js';

/** Called only after authorization, eligibility and budget checks pass. */
export async function reactToReviewStart(client: GitHubClient, pr: PullRequestDetails): Promise<void> {
  try {
    if (pr.eventName === 'issue_comment') {
      if (pr.commentId) await client.addCommentReaction?.(pr.commentId, 'eyes');
      return;
    }
    if (pr.eventName !== 'pull_request' || !client.addPullRequestReaction) return;
    const comments = await client.fetchIssueComments(pr.pullNumber);
    const previouslyReviewed = comments.some((comment) =>
      comment.user?.login === 'github-actions[bot]' && isSummaryComment(comment.body)
    );
    if (!previouslyReviewed) {
      // Repeated starts before a summary exists reuse the same bot/eyes reaction on GitHub.
      await client.addPullRequestReaction(pr.pullNumber, 'eyes');
    }
  } catch {
    // Reaction/history lookup failure must not abort the actual review or leak API errors.
  }
}
