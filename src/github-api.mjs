import { withAiSystemNotice } from './ai-notice.mjs';

const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAYS_MS = [250, 1_000];
/**
 * A ceiling on the wait GitHub asks for. A secondary rate limit typically asks
 * for a minute, which is worth waiting inside a review job; a primary limit can
 * ask for the rest of the hour, which is not, and failing fast leaves a run
 * someone can read instead of one that looks hung.
 */
const MAX_HONOURED_RETRY_AFTER_MS = 60_000;
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

/**
 * The delay before the next attempt: what the response asks for when it says so
 * and the number is usable, otherwise this attempt's own backoff. Ignoring the
 * header is what turns one throttled request into a throttled job.
 */
function retryDelayMs(response, fallbackMs) {
  const requestedSeconds = Number(response.headers.get('retry-after'));
  if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) {
    return fallbackMs;
  }
  return Math.min(requestedSeconds * 1_000, MAX_HONOURED_RETRY_AFTER_MS);
}

/**
 * The path of the next page a `Link` header points at, or `undefined` when it
 * points at none. A link to another origin is ignored rather than followed.
 */
function nextPagePath(linkHeader) {
  if (!linkHeader) return undefined;
  for (const entry of linkHeader.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="?next"?/.exec(entry);
    if (match === null) continue;
    let url;
    try {
      url = new URL(match[1]);
    } catch {
      return undefined;
    }
    if (url.origin !== API_ORIGIN) return undefined;
    return `${url.pathname}${url.search}`;
  }
  return undefined;
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

  async request(path, options) {
    return (await this.requestWithHeaders(path, options)).body;
  }

  /**
   * Used where a response's headers carry part of the answer, pagination above
   * all; every other call site wants {@link request} and its parsed body.
   */
  async requestWithHeaders(path, { method = 'GET', body } = {}) {
    for (let attempt = 0; ; attempt++) {
      const canRetry = method !== 'POST';
      let response;
      try {
        response = await this.fetchImpl(`${API_ORIGIN}${path}`, {
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
        return {
          body: text.length === 0 ? undefined : JSON.parse(text),
          headers: response.headers,
        };
      }
      if (
        attempt < this.retryDelaysMs.length &&
        canRetry &&
        isRetryableResponse(response)
      ) {
        await this.sleep(retryDelayMs(response, this.retryDelaysMs[attempt]));
        continue;
      }
      throw new GitHubApiError(method, path, response.status, text);
    }
  }

  /**
   * Collect every page, following GitHub's own `next` link rather than guessing
   * from a batch size: a short page is not proof of the last page, and some
   * endpoints and filters return one with a `next` link still set.
   */
  async paginate(path) {
    const all = [];
    const separator = path.includes('?') ? '&' : '?';
    let next = `${path}${separator}per_page=100`;
    while (next !== undefined) {
      const { body, headers } = await this.requestWithHeaders(next);
      if (!Array.isArray(body)) {
        throw new Error(`GitHub pagination returned a non-array for ${path}.`);
      }
      all.push(...body);
      next = nextPagePath(headers.get('link'));
    }
    return all;
  }

  pullRequest(number) {
    return this.request(`/repos/${this.repository}/pulls/${number}`);
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
