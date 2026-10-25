export type ReviewOperation = 'review_pr' | 'reply_to_thread';

export interface ClassificationResult {
  eligible: boolean;
  operation?: ReviewOperation;
  reasonCode?: string;
  targetFile?: string;
  cleanedQuestion?: string;
}

export interface ClassifiableEventContext {
  eventName: string;
  action?: string;
  isPullRequest: boolean;
  commentBody?: string;
  isDraft?: boolean;
  isFork?: boolean;
  senderLogin?: string;
  senderType?: string;
}

/**
 * Pure event and command classifier for AI Code Review.
 * Evaluates triggers deterministically before model setup, diff collection, or billing.
 */
export function classifyEvent(event: ClassifiableEventContext): ClassificationResult {
  // 1. Ignore bot senders to prevent automated infinite loops
  if (event.senderType === 'Bot' || event.senderLogin?.endsWith('[bot]')) {
    return { eligible: false, reasonCode: 'bot_event_ignored' };
  }

  // 2. Pull Request events
  if (event.eventName === 'pull_request') {
    const allowedActions = ['opened', 'synchronize', 'reopened'];
    if (!event.action || !allowedActions.includes(event.action)) {
      return { eligible: false, reasonCode: 'unsupported_pr_action' };
    }
    if (event.isFork) {
      return { eligible: false, reasonCode: 'fork_pr_skipped' };
    }
    if (event.isDraft) {
      return { eligible: false, reasonCode: 'draft_pr_skipped' };
    }
    return { eligible: true, operation: 'review_pr' };
  }

  // 3. Issue Comment events (PR timeline comments)
  if (event.eventName === 'issue_comment') {
    // Ordinary issue comments (not on a pull request) are skipped
    if (!event.isPullRequest) {
      return { eligible: false, reasonCode: 'comment_not_a_trigger' };
    }
    if (event.action !== 'created') {
      return { eligible: false, reasonCode: 'unsupported_comment_action' };
    }
    if (event.isFork) {
      return { eligible: false, reasonCode: 'fork_pr_skipped' };
    }
    if (event.isDraft) {
      return { eligible: false, reasonCode: 'draft_pr_skipped' };
    }

    const comment = (event.commentBody || '').trim();
    const parts = comment.split(/\s+/);
    const command = parts[0]?.toLowerCase();

    if (!command || !['/review', '/ai-review', '/recheck'].includes(command)) {
      return { eligible: false, reasonCode: 'comment_not_a_trigger' };
    }

    // Single command: full PR review
    if (parts.length === 1) {
      return { eligible: true, operation: 'review_pr' };
    }

    // Exact single-file argument: /review <filepath>
    if (parts.length === 2) {
      const target = parts[1];
      if (target.startsWith('-') || /[\x00-\x1f]/.test(target)) {
        return { eligible: false, reasonCode: 'invalid_command_arguments' };
      }
      return { eligible: true, operation: 'review_pr', targetFile: target };
    }

    // More than 2 arguments: invalid command syntax (strict grammar, do not silently broaden)
    return { eligible: false, reasonCode: 'invalid_command_arguments' };
  }

  // 4. Pull Request Review Comment events (Inline diff thread discussions)
  if (event.eventName === 'pull_request_review_comment') {
    if (event.action !== 'created') {
      return { eligible: false, reasonCode: 'unsupported_comment_action' };
    }
    if (event.isFork) {
      return { eligible: false, reasonCode: 'fork_pr_skipped' };
    }
    if (event.isDraft) {
      return { eligible: false, reasonCode: 'draft_pr_skipped' };
    }

    const comment = (event.commentBody || '').trim();
    if (!comment) {
      return { eligible: false, reasonCode: 'comment_not_a_trigger' };
    }

    const isExplicitCommand = /^\/(?:review|ai-review|ask|explain|why|recheck)(?:\s+.*)?$/i.test(comment);
    if (!isExplicitCommand) {
      // Ordinary developer comments (e.g. "thanks", "done", "fixed") are skipped!
      return { eligible: false, reasonCode: 'comment_not_a_trigger' };
    }

    const cleanedQuestion = comment.replace(/^\/(?:review|ai-review|ask|explain|why|recheck)\s*/i, '').trim();
    return {
      eligible: true,
      operation: 'reply_to_thread',
      cleanedQuestion: cleanedQuestion || 'Please explain this finding and how to address it.',
    };
  }

  // 5. Any other unsupported event
  return { eligible: false, reasonCode: 'unsupported_event' };
}
