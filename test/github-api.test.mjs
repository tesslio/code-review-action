import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AI_SYSTEM_NOTICE } from '../src/ai-notice.mjs';
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

test('adds the AI-system notice at every Markdown publication boundary', async () => {
  const requests = [];
  const api = new GitHubCodeReviewApi({
    token: 'token',
    repository: 'acme/widgets',
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return response(200, '{}');
    },
  });

  await api.createReview(10, {
    event: 'COMMENT',
    body: 'Review summary.',
    comments: [{ path: 'src/a.js', line: 1, body: 'Inline finding.' }],
  });
  await api.reply(10, 20, 'Reconciliation reply.');
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

  const bodies = [
    requests[0].body.body,
    requests[0].body.comments[0].body,
    requests[1].body.body,
    requests[2].body.output.summary,
    requests[3].body.output.summary,
    requests[4].body.body,
    requests[5].body.body,
  ];
  for (const body of bodies) {
    assert.equal(body.split(AI_SYSTEM_NOTICE).length - 1, 1);
  }
});
