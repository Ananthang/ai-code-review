import { describe, expect, it } from 'vitest';
import { classifyEvent } from '../src/github/classifier.js';

describe('Event & Command Classifier (Pure Trigger Logic)', () => {
  it('ignores automated bot senders to prevent feedback loops', () => {
    const res = classifyEvent({
      eventName: 'issue_comment',
      action: 'created',
      isPullRequest: true,
      commentBody: '/review',
      senderType: 'Bot',
    });
    expect(res.eligible).toBe(false);
    expect(res.reasonCode).toBe('bot_event_ignored');
  });

  it('classifies eligible PR opened, synchronize, reopened', () => {
    for (const action of ['opened', 'synchronize', 'reopened']) {
      const res = classifyEvent({
        eventName: 'pull_request',
        action,
        isPullRequest: true,
        isDraft: false,
        isFork: false,
      });
      expect(res.eligible).toBe(true);
      expect(res.operation).toBe('review_pr');
    }
  });

  it('skips unsupported PR actions (e.g. closed, labeled)', () => {
    const res = classifyEvent({
      eventName: 'pull_request',
      action: 'labeled',
      isPullRequest: true,
    });
    expect(res.eligible).toBe(false);
    expect(res.reasonCode).toBe('unsupported_pr_action');
  });

  it('skips fork pull requests', () => {
    const res = classifyEvent({
      eventName: 'pull_request',
      action: 'opened',
      isPullRequest: true,
      isFork: true,
    });
    expect(res.eligible).toBe(false);
    expect(res.reasonCode).toBe('fork_pr_skipped');
  });

  it('skips draft pull requests', () => {
    const res = classifyEvent({
      eventName: 'pull_request',
      action: 'opened',
      isPullRequest: true,
      isDraft: true,
    });
    expect(res.eligible).toBe(false);
    expect(res.reasonCode).toBe('draft_pr_skipped');
  });

  it('skips ordinary issue comments (not on a pull request)', () => {
    const res = classifyEvent({
      eventName: 'issue_comment',
      action: 'created',
      isPullRequest: false,
      commentBody: '/review',
    });
    expect(res.eligible).toBe(false);
    expect(res.reasonCode).toBe('comment_not_a_trigger');
  });

  it('classifies PR timeline /review as full review', () => {
    const res = classifyEvent({
      eventName: 'issue_comment',
      action: 'created',
      isPullRequest: true,
      commentBody: '  /review  ',
    });
    expect(res.eligible).toBe(true);
    expect(res.operation).toBe('review_pr');
    expect(res.targetFile).toBeUndefined();
  });

  it('classifies PR timeline /review <path> as targeted review', () => {
    const res = classifyEvent({
      eventName: 'issue_comment',
      action: 'created',
      isPullRequest: true,
      commentBody: '/review src/components/button.tsx',
    });
    expect(res.eligible).toBe(true);
    expect(res.operation).toBe('review_pr');
    expect(res.targetFile).toBe('src/components/button.tsx');
  });

  it('rejects malformed commands with extra arguments (Phase 1 strict parsing)', () => {
    const res = classifyEvent({
      eventName: 'issue_comment',
      action: 'created',
      isPullRequest: true,
      commentBody: '/review src/a.ts extra-arg',
    });
    expect(res.eligible).toBe(false);
    expect(res.reasonCode).toBe('invalid_command_arguments');
  });

  it('rejects commands with flags or options', () => {
    const res = classifyEvent({
      eventName: 'issue_comment',
      action: 'created',
      isPullRequest: true,
      commentBody: '/review --all',
    });
    expect(res.eligible).toBe(false);
    expect(res.reasonCode).toBe('invalid_command_arguments');
  });

  it('classifies explicit inline thread questions (/ask, /review, /explain)', () => {
    const res = classifyEvent({
      eventName: 'pull_request_review_comment',
      action: 'created',
      isPullRequest: true,
      commentBody: '/ask why is this needed in production?',
    });
    expect(res.eligible).toBe(true);
    expect(res.operation).toBe('reply_to_thread');
    expect(res.cleanedQuestion).toBe('why is this needed in production?');
  });

  it('skips ordinary developer chat in inline threads (e.g. thanks, done)', () => {
    const res = classifyEvent({
      eventName: 'pull_request_review_comment',
      action: 'created',
      isPullRequest: true,
      commentBody: 'Thanks! Fixed in the latest commit.',
    });
    expect(res.eligible).toBe(false);
    expect(res.reasonCode).toBe('comment_not_a_trigger');
  });

  it('skips unsupported events (e.g. push)', () => {
    const res = classifyEvent({
      eventName: 'push',
      action: '',
      isPullRequest: false,
    });
    expect(res.eligible).toBe(false);
    expect(res.reasonCode).toBe('unsupported_event');
  });
});
