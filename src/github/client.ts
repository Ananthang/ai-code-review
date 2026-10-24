import * as github from '@actions/github';

export interface PullRequestDetails {
  owner: string;
  repo: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  isDraft: boolean;
  isFork: boolean;
  action: string;
  eventName: string;
}

export interface GitHubFile {
  filename: string;
  status: 'added' | 'modified' | 'renamed' | 'removed' | 'copied' | 'changed' | 'unchanged';
  previous_filename?: string;
  patch?: string;
  changes: number;
  additions: number;
  deletions: number;
}

export interface ExistingReviewComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  user: { login: string } | null;
}

export interface ExistingIssueComment {
  id: number;
  body: string;
  user: { login: string } | null;
}

export interface ReviewCommentPayload {
  path: string;
  line: number;
  body: string;
}

export interface GitHubClient {
  getPullRequestDetails(): PullRequestDetails;
  fetchPullRequestFiles(pullNumber: number): Promise<{ files: GitHubFile[]; isComplete: boolean }>;
  getHeadSha(pullNumber: number): Promise<string>;
  fetchReviewComments(pullNumber: number): Promise<ExistingReviewComment[]>;
  fetchIssueComments(issueNumber: number): Promise<ExistingIssueComment[]>;
  publishReviewComments(
    pullNumber: number,
    commitSha: string,
    comments: ReviewCommentPayload[]
  ): Promise<{ publishedCount: number; errors: string[] }>;
  createOrUpdateSummary(
    issueNumber: number,
    summaryBody: string,
    existingCommentId?: number
  ): Promise<{ commentId: number }>;
}

export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: ReturnType<typeof github.getOctokit>;
  private readonly owner: string;
  private readonly repo: string;

  constructor(token: string, owner?: string, repo?: string) {
    this.octokit = github.getOctokit(token);
    this.owner = owner || github.context.repo.owner;
    this.repo = repo || github.context.repo.repo;
  }

  public getPullRequestDetails(): PullRequestDetails {
    const payload = github.context.payload;
    const pr = payload.pull_request;
    const eventName = github.context.eventName;
    const action = payload.action || '';

    if (!pr) {
      throw new Error(`Event '${eventName}' does not contain a pull_request payload`);
    }

    const headRepoFullName = pr.head?.repo?.full_name;
    const baseRepoFullName = pr.base?.repo?.full_name;
    const isFork = Boolean(headRepoFullName && baseRepoFullName && headRepoFullName !== baseRepoFullName);
    const isDraft = Boolean(pr.draft);

    return {
      owner: this.owner,
      repo: this.repo,
      pullNumber: pr.number,
      baseSha: pr.base?.sha || '',
      headSha: pr.head?.sha || '',
      isDraft,
      isFork,
      action,
      eventName,
    };
  }

  public async fetchPullRequestFiles(pullNumber: number): Promise<{ files: GitHubFile[]; isComplete: boolean }> {
    try {
      const files: GitHubFile[] = [];
      let page = 1;
      const perPage = 100;
      const maxPages = 10; // safety bound: up to 1000 files

      while (page <= maxPages) {
        const response = await this.octokit.rest.pulls.listFiles({
          owner: this.owner,
          repo: this.repo,
          pull_number: pullNumber,
          per_page: perPage,
          page,
        });

        const batch = response.data as GitHubFile[];
        files.push(...batch);

        if (batch.length < perPage) {
          return { files, isComplete: true };
        }
        page++;
      }

      // If we reached maxPages and there were still perPage items, inventory is incomplete
      return { files, isComplete: false };
    } catch (err: unknown) {
      throw this.sanitizeError(err, 'Failed to fetch pull request files');
    }
  }

  public async getHeadSha(pullNumber: number): Promise<string> {
    try {
      const response = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: pullNumber,
      });
      return response.data.head.sha;
    } catch (err: unknown) {
      throw this.sanitizeError(err, 'Failed to re-fetch head SHA');
    }
  }

  public async fetchReviewComments(pullNumber: number): Promise<ExistingReviewComment[]> {
    try {
      const comments: ExistingReviewComment[] = [];
      let page = 1;
      const perPage = 100;
      const maxPages = 10;

      while (page <= maxPages) {
        const response = await this.octokit.rest.pulls.listReviewComments({
          owner: this.owner,
          repo: this.repo,
          pull_number: pullNumber,
          per_page: perPage,
          page,
        });

        comments.push(...(response.data as ExistingReviewComment[]));
        if (response.data.length < perPage) break;
        page++;
      }

      return comments;
    } catch (err: unknown) {
      throw this.sanitizeError(err, 'Failed to fetch existing review comments');
    }
  }

  public async fetchIssueComments(issueNumber: number): Promise<ExistingIssueComment[]> {
    try {
      const comments: ExistingIssueComment[] = [];
      let page = 1;
      const perPage = 100;
      const maxPages = 5;

      while (page <= maxPages) {
        const response = await this.octokit.rest.issues.listComments({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          per_page: perPage,
          page,
        });

        comments.push(...(response.data as ExistingIssueComment[]));
        if (response.data.length < perPage) break;
        page++;
      }

      return comments;
    } catch (err: unknown) {
      throw this.sanitizeError(err, 'Failed to fetch existing issue comments');
    }
  }

  public async publishReviewComments(
    pullNumber: number,
    commitSha: string,
    comments: ReviewCommentPayload[]
  ): Promise<{ publishedCount: number; errors: string[] }> {
    if (comments.length === 0) {
      return { publishedCount: 0, errors: [] };
    }

    try {
      // First attempt: atomic review with event: 'COMMENT' (never APPROVE or REQUEST_CHANGES)
      await this.octokit.rest.pulls.createReview({
        owner: this.owner,
        repo: this.repo,
        pull_number: pullNumber,
        commit_id: commitSha,
        event: 'COMMENT',
        comments: comments.map((c) => ({
          path: c.path,
          line: c.line,
          side: 'RIGHT',
          body: c.body,
        })),
      });

      return { publishedCount: comments.length, errors: [] };
    } catch (batchErr: unknown) {
      // If batch review fails (e.g. line validation on a single comment or permission),
      // attempt fallback individual comment publication so valid comments are not lost
      const errors: string[] = [];
      let published = 0;

      for (const comment of comments) {
        try {
          await this.octokit.rest.pulls.createReviewComment({
            owner: this.owner,
            repo: this.repo,
            pull_number: pullNumber,
            commit_id: commitSha,
            path: comment.path,
            line: comment.line,
            side: 'RIGHT',
            body: comment.body,
          });
          published++;
        } catch (individualErr: unknown) {
          const sanitized = this.sanitizeError(individualErr, `Failed to publish comment on ${comment.path}:${comment.line}`);
          errors.push(sanitized.message);
        }
      }

      return { publishedCount: published, errors };
    }
  }

  public async createOrUpdateSummary(
    issueNumber: number,
    summaryBody: string,
    existingCommentId?: number
  ): Promise<{ commentId: number }> {
    try {
      if (existingCommentId) {
        const response = await this.octokit.rest.issues.updateComment({
          owner: this.owner,
          repo: this.repo,
          comment_id: existingCommentId,
          body: summaryBody,
        });
        return { commentId: response.data.id };
      } else {
        const response = await this.octokit.rest.issues.createComment({
          owner: this.owner,
          repo: this.repo,
          issue_number: issueNumber,
          body: summaryBody,
        });
        return { commentId: response.data.id };
      }
    } catch (err: unknown) {
      throw this.sanitizeError(err, 'Failed to create or update summary comment');
    }
  }

  private sanitizeError(err: unknown, contextMsg: string): Error {
    if (err instanceof Error) {
      // Remove any bearer tokens or sensitive query strings from error message
      const sanitized = err.message
        .replace(/ghp_[0-9a-zA-Z]{36}/g, '[REDACTED_TOKEN]')
        .replace(/token\s+[^\s]+/gi, 'token [REDACTED]')
        .replace(/bearer\s+[^\s]+/gi, 'bearer [REDACTED]');
      return new Error(`${contextMsg}: ${sanitized}`);
    }
    return new Error(`${contextMsg}: Unknown error`);
  }
}
