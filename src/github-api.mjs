import { withAiSystemNotice } from './ai-notice.mjs';

const API_VERSION = '2022-11-28';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAYS_MS = [250, 1_000];
// Conversation comments and inline review comments are different resources with
// separate reaction endpoints and separate id spaces, so a kind this map does
// not name cannot be guessed at: the wrong endpoint would address a different
// comment, not fail.
const REACTION_COLLECTIONS = new Map([
  ['issue-comment', 'issues'],
  ['review-comment', 'pulls'],
]);

function noticedCheckRunPayload(payload) {
  if (payload.output === undefined) return payload;
  return {
    ...payload,
    output: {
      ...payload.output,
      summary: withAiSystemNotice(payload.output.summary),
    },
  };
}

function isRetryableResponse(response) {
  if (response.status === 429 || response.status >= 500) return true;
  if (response.status !== 403) return false;
  return (
    response.headers.get('retry-after') !== null ||
    response.headers.get('x-ratelimit-remaining') === '0'
  );
}

export class GitHubApiError extends Error {
  constructor(method, path, status, body) {
    super(`GitHub ${method} ${path} failed (${status}): ${body}`);
    this.status = status;
    this.body = body;
  }
}

export class GitHubCodeReviewApi {
  constructor({
    token,
    repository,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  }) {
    const parts = repository.split('/');
    if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
      throw new Error(`Repository must be owner/repo, got ${repository}.`);
    }
    if (!token) throw new Error('A GitHub token is required.');
    this.repository = repository;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.retryDelaysMs = retryDelaysMs;
    this.sleep = sleep;
    this.headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
    };
  }

  async request(path, { method = 'GET', body } = {}) {
    for (let attempt = 0; ; attempt++) {
      const canRetry = method !== 'POST';
      let response;
      try {
        response = await this.fetchImpl(`https://api.github.com${path}`, {
          method,
          headers: {
            ...this.headers,
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (!canRetry || attempt >= this.retryDelaysMs.length) throw error;
        await this.sleep(this.retryDelaysMs[attempt]);
        continue;
      }
      const text = await response.text();
      if (response.ok) {
        return text.length === 0 ? undefined : JSON.parse(text);
      }
      if (
        attempt < this.retryDelaysMs.length &&
        canRetry &&
        isRetryableResponse(response)
      ) {
        await this.sleep(this.retryDelaysMs[attempt]);
        continue;
      }
      throw new GitHubApiError(method, path, response.status, text);
    }
  }

  async paginate(path) {
    const all = [];
    for (let page = 1; ; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const batch = await this.request(
        `${path}${separator}per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) {
        throw new Error(`GitHub pagination returned a non-array for ${path}.`);
      }
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  }

  pullRequest(number) {
    return this.request(`/repos/${this.repository}/pulls/${number}`);
  }

  files(number) {
    return this.paginate(`/repos/${this.repository}/pulls/${number}/files`);
  }

  reviews(number) {
    return this.paginate(`/repos/${this.repository}/pulls/${number}/reviews`);
  }

  reviewComments(number) {
    return this.paginate(`/repos/${this.repository}/pulls/${number}/comments`);
  }

  createReview(number, payload) {
    const noticed = {
      ...payload,
      body: withAiSystemNotice(payload.body),
      ...(payload.comments === undefined
        ? {}
        : {
            comments: payload.comments.map((comment) => ({
              ...comment,
              body: withAiSystemNotice(comment.body),
            })),
          }),
    };
    return this.request(`/repos/${this.repository}/pulls/${number}/reviews`, {
      method: 'POST',
      body: noticed,
    });
  }

  reply(number, rootCommentId, body) {
    return this.request(
      `/repos/${this.repository}/pulls/${number}/comments/${rootCommentId}/replies`,
      { method: 'POST', body: { body: withAiSystemNotice(body) } },
    );
  }

  createCheckRun(payload) {
    return this.request(`/repos/${this.repository}/check-runs`, {
      method: 'POST',
      body: noticedCheckRunPayload(payload),
    });
  }

  updateCheckRun(checkRunId, payload) {
    return this.request(
      `/repos/${this.repository}/check-runs/${checkRunId}`,
      { method: 'PATCH', body: noticedCheckRunPayload(payload) },
    );
  }

  issueComments(number) {
    return this.paginate(`/repos/${this.repository}/issues/${number}/comments`);
  }

  createIssueComment(number, body) {
    return this.request(`/repos/${this.repository}/issues/${number}/comments`, {
      method: 'POST',
      body: { body: withAiSystemNotice(body) },
    });
  }

  updateIssueComment(commentId, body) {
    return this.request(
      `/repos/${this.repository}/issues/comments/${commentId}`,
      {
        method: 'PATCH',
        body: { body: withAiSystemNotice(body) },
      },
    );
  }

  /**
   * React to a comment. `kind` is `'issue-comment'` for a conversation comment
   * or `'review-comment'` for an inline review comment; any other value throws.
   */
  addCommentReaction({ kind, commentId, content }) {
    const collection = REACTION_COLLECTIONS.get(kind);
    if (collection === undefined) {
      throw new Error(
        `Comment kind must be issue-comment or review-comment, got ${kind}.`,
      );
    }
    return this.request(
      `/repos/${this.repository}/${collection}/comments/${commentId}/reactions`,
      { method: 'POST', body: { content } },
    );
  }

  deleteIssueComment(commentId) {
    return this.request(
      `/repos/${this.repository}/issues/comments/${commentId}`,
      {
        method: 'DELETE',
      },
    );
  }
}
