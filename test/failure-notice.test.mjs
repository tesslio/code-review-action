import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FAILURE_MARKER,
  publishFailureNotice,
  removeFailureNotices,
} from '../src/failure-notice.mjs';

function recordingApi(comments = []) {
  const calls = [];
  return {
    calls,
    issueComments: () => comments,
    createIssueComment(prNumber, body) {
      calls.push({ method: 'create', prNumber, body });
      return { id: 11 };
    },
    updateIssueComment(commentId, body) {
      calls.push({ method: 'update', commentId, body });
      return { id: commentId };
    },
    deleteIssueComment(commentId) {
      calls.push({ method: 'delete', commentId });
    },
  };
}

const runUrl = 'https://github.example/run/1';

test('a notice names the reason the run stopped', async () => {
  const api = recordingApi();

  await publishFailureNotice({
    api,
    prNumber: 42,
    runUrl,
    reason: 'Lens ref "./review-lenses/gone/SKILL.md" does not resolve.',
  });

  const [{ body }] = api.calls;
  assert.match(body, /`Lens ref "\.\/review-lenses\/gone\/SKILL\.md" does not resolve\.`/);
  assert.match(body, /did not complete/);
  assert.match(body, /View the workflow run/);
});

test('a notice with no reason to quote is the sentence and the link', async () => {
  const api = recordingApi();

  await publishFailureNotice({ api, prNumber: 42, runUrl });

  const [{ body }] = api.calls;
  assert.equal(
    body,
    `${FAILURE_MARKER}\nTessl Code Review did not complete. [View the workflow run](${runUrl}).`,
  );
});

test('a later run replaces the notice rather than adding one', async () => {
  const api = recordingApi([
    {
      id: 7,
      user: { login: 'github-actions[bot]' },
      body: `${FAILURE_MARKER}\nan earlier failure`,
    },
  ]);

  const published = await publishFailureNotice({
    api,
    prNumber: 42,
    runUrl,
    reason: 'Unknown profile.',
  });

  assert.deepEqual(published, { status: 'updated', commentId: 7 });
  assert.equal(api.calls[0].method, 'update');
  assert.match(api.calls[0].body, /`Unknown profile\.`/);
});

test('a completed review clears the notices left behind', async () => {
  const api = recordingApi([
    { id: 7, user: { login: 'github-actions[bot]' }, body: FAILURE_MARKER },
    { id: 8, user: { login: 'someone' }, body: FAILURE_MARKER },
    { id: 9, user: { login: 'github-actions[bot]' }, body: 'unrelated' },
  ]);

  assert.equal(await removeFailureNotices({ api, prNumber: 42 }), 1);
  assert.deepEqual(api.calls, [{ method: 'delete', commentId: 7 }]);
});
