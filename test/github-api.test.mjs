import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GitHubApiError, GitHubCodeReviewApi } from '../src/github-api.mjs';

function response(status, body = '') {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('uses a timeout and retries bounded transient failures', async () => {
  const calls = [];
  const delays = [];
  const api = new GitHubCodeReviewApi({
    token: 'token',
    repository: 'acme/widgets',
    timeoutMs: 123,
    retryDelaysMs: [5],
    sleep: async (delay) => delays.push(delay),
    fetchImpl: async (_url, options) => {
      calls.push(options);
      return calls.length === 1
        ? response(503, '{"message":"try again"}')
        : response(200, '{"ok":true}');
    },
  });

  assert.deepEqual(await api.request('/test'), { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [5]);
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test('does not retry a permissions failure', async () => {
  let calls = 0;
  const api = new GitHubCodeReviewApi({
    token: 'token',
    repository: 'acme/widgets',
    retryDelaysMs: [0],
    fetchImpl: async () => {
      calls++;
      return response(403, '{"message":"forbidden"}');
    },
  });

  await assert.rejects(api.request('/test'), GitHubApiError);
  assert.equal(calls, 1);
});

test('does not retry a mutating POST that could already have succeeded', async () => {
  let calls = 0;
  const api = new GitHubCodeReviewApi({
    token: 'token',
    repository: 'acme/widgets',
    retryDelaysMs: [0],
    fetchImpl: async () => {
      calls++;
      return response(503, '{"message":"unknown write outcome"}');
    },
  });

  await assert.rejects(
    api.request('/test', { method: 'POST', body: { value: true } }),
    GitHubApiError,
  );
  assert.equal(calls, 1);
});

test('publishes its own bodies verbatim, with no marker of its own', async () => {
  const requests = [];
  const api = new GitHubCodeReviewApi({
    token: 'token',
    repository: 'acme/widgets',
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return response(200, '{}');
    },
  });

  await api.createCheckRun({
    name: 'Tessl Code Review',
    output: { title: 'Review in progress', summary: 'Starting review.' },
  });
  await api.updateCheckRun(30, {
    status: 'completed',
    output: { title: 'Changes approved', summary: 'Review complete.' },
  });
  await api.createIssueComment(10, 'Failure notice.');
  await api.updateIssueComment(40, 'Updated failure notice.');

  assert.deepEqual(
    [
      requests[0].body.output.summary,
      requests[1].body.output.summary,
      requests[2].body.body,
      requests[3].body.body,
    ],
    [
      'Starting review.',
      'Review complete.',
      'Failure notice.',
      'Updated failure notice.',
    ],
  );
});

test('publishes no review of its own, which the CLI owns', () => {
  const api = new GitHubCodeReviewApi({ token: 'token', repository: 'a/b' });

  for (const gone of ['createReview', 'reply', 'reviews', 'reviewComments', 'files']) {
    assert.equal(api[gone], undefined, `${gone} should not exist`);
  }
});

test('follows the pagination link rather than guessing from a short page', async () => {
  const paths = [];
  const api = new GitHubCodeReviewApi({
    token: 'token',
    repository: 'acme/widgets',
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname + new URL(url).search);
      // A short first page that still advertises a next page: the case a
      // batch-size check reads as the end of the collection.
      return paths.length === 1
        ? new Response('[{"id":1}]', {
            status: 200,
            headers: {
              'content-type': 'application/json',
              link: '<https://api.github.com/repos/acme/widgets/issues/9/comments?per_page=100&page=2>; rel="next", <https://api.github.com/repos/acme/widgets/issues/9/comments?per_page=100&page=9>; rel="last"',
            },
          })
        : response(200, '[{"id":2}]');
    },
  });

  assert.deepEqual(await api.issueComments(9), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(paths, [
    '/repos/acme/widgets/issues/9/comments?per_page=100',
    '/repos/acme/widgets/issues/9/comments?per_page=100&page=2',
  ]);
});

test('reads a next link whose parameters come in any order', async () => {
  const paths = [];
  const api = new GitHubCodeReviewApi({
    token: 'token',
    repository: 'acme/widgets',
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      paths.push(parsed.pathname + parsed.search);
      // rel before another parameter, quoted as a token list, and a comma inside
      // the URI: all valid, and all forms the first parser would have missed.
      return paths.length === 1
        ? new Response('[{"id":1}]', {
            status: 200,
            headers: {
              'content-type': 'application/json',
              link: '<https://api.github.com/repos/acme/widgets/issues/9/comments?per_page=100&labels=a,b&page=2>; rel="next prev"; type="application/json"',
            },
          })
        : response(200, '[{"id":2}]');
    },
  });

  assert.deepEqual(await api.issueComments(9), [{ id: 1 }, { id: 2 }]);
  assert.equal(
    paths[1],
    '/repos/acme/widgets/issues/9/comments?per_page=100&labels=a,b&page=2',
  );
});

test('ignores a pagination link pointing at another origin', async () => {
  let calls = 0;
  const api = new GitHubCodeReviewApi({
    token: 'token',
    repository: 'acme/widgets',
    fetchImpl: async () => {
      calls += 1;
      return new Response('[{"id":1}]', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          link: '<https://evil.example/repos/acme/widgets/issues/9/comments?page=2>; rel="next"',
        },
      });
    },
  });

  assert.deepEqual(await api.issueComments(9), [{ id: 1 }]);
  assert.equal(calls, 1);
});

test('waits as long as a throttled response asks, up to a ceiling', async () => {
  const delays = [];
  function apiWithRetryAfter(retryAfter) {
    let calls = 0;
    return new GitHubCodeReviewApi({
      token: 'token',
      repository: 'acme/widgets',
      retryDelaysMs: [250],
      sleep: async (delay) => delays.push(delay),
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? new Response('{"message":"slow down"}', {
              status: 403,
              headers: {
                'content-type': 'application/json',
                'retry-after': retryAfter,
              },
            })
          : response(200, '{"ok":true}');
      },
    });
  }

  await apiWithRetryAfter('7').request('/test');
  await apiWithRetryAfter('3600').request('/test');
  await apiWithRetryAfter('not-a-date-or-a-number').request('/test');

  // The asked-for wait, the ceiling, then this attempt's own backoff when the
  // header cannot be read at all.
  assert.deepEqual(delays, [7_000, 60_000, 250]);
});

test('reads a Retry-After given as an HTTP date', async () => {
  const nowMs = Date.parse('2026-08-19T12:00:00Z');
  const delays = [];
  let calls = 0;
  const api = new GitHubCodeReviewApi({
    token: 'token',
    repository: 'acme/widgets',
    retryDelaysMs: [250],
    sleep: async (delay) => delays.push(delay),
    now: () => nowMs,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response('{"message":"slow down"}', {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'retry-after': 'Wed, 19 Aug 2026 12:00:12 GMT',
            },
          })
        : response(200, '{"ok":true}');
    },
  });

  await api.request('/test');

  assert.deepEqual(delays, [12_000]);
});

test('treats a Retry-After date already past as no wait at all', async () => {
  const delays = [];
  let calls = 0;
  const api = new GitHubCodeReviewApi({
    token: 'token',
    repository: 'acme/widgets',
    retryDelaysMs: [250],
    sleep: async (delay) => delays.push(delay),
    now: () => Date.parse('2026-08-19T12:00:00Z'),
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response('{}', {
            status: 500,
            headers: {
              'content-type': 'application/json',
              'retry-after': 'Wed, 19 Aug 2026 11:59:30 GMT',
            },
          })
        : response(200, '{"ok":true}');
    },
  });

  await api.request('/test');

  assert.deepEqual(delays, [0]);
});

test('refuses a comment kind it has no endpoint for', () => {
  const api = new GitHubCodeReviewApi({
    token: 'token',
    repository: 'acme/widgets',
    fetchImpl: async () => {
      throw new Error('no request should be attempted');
    },
  });

  assert.throws(
    () =>
      api.addCommentReaction({
        kind: 'review_comment',
        commentId: '1',
        content: 'eyes',
      }),
    /issue-comment or review-comment, got review_comment/,
  );
});
