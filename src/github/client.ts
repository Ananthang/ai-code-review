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
  commentBody?: string;
  commentId?: number;
  targetFile?: string;
  mayTriggerReview?: boolean;
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
  fetchSourceFile?(path: string, sha: string, maxBytes: number): Promise<string | undefined>;
  getPullRequestDetails(): Promise<PullRequestDetails>;
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
  addPullRequestReaction?(pullNumber: number, reaction: 'eyes'): Promise<void>;
  addCommentReaction?(
    commentId: number,
    reaction: '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes'
  ): Promise<void>;
}

export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: ReturnType<typeof github.getOctokit>;
  private readonly owner: string;
  private readonly repo: string;

  constructor(token: string, owner?: string, repo?: string) {
    this.octokit = github.getOctokit(token, { request: { timeout: 15000 } });
    this.owner = owner || github.context.repo.owner;
    this.repo = repo || github.context.repo.repo;
  }

  public async fetchSourceFile(filePath: string, sha: string, maxBytes: number): Promise<string | undefined> {
    if (!/^[a-f0-9]{40,64}$/.test(sha) || maxBytes <= 0 || maxBytes > 8192) return undefined;
    const parts = filePath.split('/');
    if (parts.length > 8 || parts.some(p => !p || p === '.' || p === '..') || /[\\\x00-\x1f]/.test(filePath)) return undefined;
    // Walk immutable Git trees; symlinks and submodules are never followed.
    let treeSha = sha;
    for (let i = 0; i < parts.length; i++) {
      const response = await this.octokit.rest.git.getTree({ owner: this.owner, repo: this.repo, tree_sha: treeSha });
      if (response.data.truncated) return undefined;
      const entry = response.data.tree.find(item => item.path === parts[i]);
      if (!entry?.sha) return undefined;
      if (i < parts.length - 1) {
        if (entry.type !== 'tree' || entry.mode !== '040000') return undefined;
        treeSha = entry.sha;
      } else {
        if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode ?? '') ||
            entry.size === undefined || entry.size > maxBytes) return undefined;
        const blob = await this.octokit.rest.git.getBlob({ owner: this.owner, repo: this.repo, file_sha: entry.sha });
        if (blob.data.encoding !== 'base64' || blob.data.size == null || blob.data.size > maxBytes) return undefined;
        const bytes = Buffer.from(blob.data.content, 'base64');
        if (bytes.length > maxBytes) return undefined;
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      }
    }
    return undefined;
  }

  public async getPullRequestDetails(): Promise<PullRequestDetails> {
    const payload = github.context.payload;
    const eventName = github.context.eventName;
    const action = payload.action || '';

    // Support issue_comment event on pull requests (e.g. comment triggers like /review)
    if (eventName === 'issue_comment') {
      if (!payload.issue?.pull_request) {
        throw new Error("Event 'issue_comment' is not associated with a pull request");
      }
      const pullNumber = payload.issue.number;
      let mayTriggerReview = false;
      if (payload.action === 'created' && payload.sender?.login) {
        try {
          const permission = await this.octokit.rest.repos.getCollaboratorPermissionLevel({
            owner: this.owner, repo: this.repo, username: payload.sender.login,
          });
          mayTriggerReview = ['admin', 'maintain', 'write'].includes(permission.data.permission);
        } catch { /* Fail closed when authorization cannot be established. */ }
      }
      const response = await this.octokit.rest.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: pullNumber,
      });

      const pr = response.data;
      const headRepoFullName = pr.head?.repo?.full_name;
      const baseRepoFullName = pr.base?.repo?.full_name;
      const isFork = !headRepoFullName || !baseRepoFullName || headRepoFullName !== baseRepoFullName;
      const isDraft = Boolean(pr.draft);
      const commentBody = payload.comment?.body || '';

      // Parse optional target file filter, e.g. "/review src/user.ts"
      let targetFile: string | undefined;
      const parts = commentBody.trim().split(/\s+/);
      if (parts.length > 1 && !parts[1].startsWith('-')) {
        targetFile = parts[1];
      }

      return {
        owner: this.owner,
        repo: this.repo,
        pullNumber,
        baseSha: pr.base.sha,
        headSha: pr.head.sha,
        isDraft,
        isFork,
        action,
        eventName,
        commentBody,
        commentId: payload.comment?.id,
        targetFile,
        mayTriggerReview,
      };
    }

    const pr = payload.pull_request;
    if (!pr) {
      throw new Error(`Event '${eventName}' does not contain a pull_request payload`);
    }

    const headRepoFullName = pr.head?.repo?.full_name;
    const baseRepoFullName = pr.base?.repo?.full_name;
    const isFork = !headRepoFullName || !baseRepoFullName || headRepoFullName !== baseRepoFullName;
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

  public async addCommentReaction(
    commentId: number,
    reaction: '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes'
  ): Promise<void> {
    try {
      await this.octokit.rest.reactions.createForIssueComment({
        owner: this.owner,
        repo: this.repo,
        comment_id: commentId,
        content: reaction,
      });
    } catch {
      // Ignored if reaction fails or token lacks reaction permissions
    }
  }

  public async addPullRequestReaction(pullNumber: number, reaction: 'eyes'): Promise<void> {
    try {
      // A PR description uses the issue reaction endpoint, not an issue-comment ID.
      await this.octokit.rest.reactions.createForIssue({
        owner: this.owner,
        repo: this.repo,
        issue_number: pullNumber,
        content: reaction,
      });
    } catch {
      // Cosmetic feedback must not prevent review when permissions are limited.
    }
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
        if (page === maxPages) throw new Error('Comment inventory incomplete');
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
        if (page === maxPages) throw new Error('Comment inventory incomplete');
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
    } catch {
      // A failed response may follow a successful write. Never blindly retry.
      return { publishedCount: 0, errors: ['publication_outcome_unknown'] };
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
    return new Error(contextMsg);
  }
}
