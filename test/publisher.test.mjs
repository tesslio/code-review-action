import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GitHubApiError } from '../src/github-api.mjs';
import { FAILURE_MARKER, attemptMarker } from '../src/protocol.mjs';
import {
  publishCodeReview,
  publishFailureNotice,
  removeFailureNotices,
} from '../src/publisher.mjs';

function result(overrides = {}) {
  // Every surfaced finding defaults to requiring changes (matching a first-round
  // review), and `approved` is derived unless a case overrides it.
  const findings = (overrides.findings ?? []).map((f) => ({
    requiresChanges: true,
    ...f,
  }));
  return {
    status: 'ok',
    outcome: {
      schemaVersion: 1,
      runId: 'review-run',
      subject: {
        schemaVersion: 1,
        repository: 'https://github.com/acme/widgets.git',
        change: {
          baseRevision: 'base',
          headRevision: 'head',
          headKind: 'commit',
        },
      },
      effort: 'standard',
      judgement: 'One concern remains.',
      approved: !findings.some((f) => f.requiresChanges),
      reconciliation: [],
      ...overrides,
      findings,
    },
    diagnostics: { durationMs: 10 },
  };
}

function fakeApi(overrides = {}) {
  const calls = [];
  return {
    calls,
    pullRequest: async () => ({ head: { sha: 'head' } }),
    reviews: async () => [],
    files: async () => [],
    createReview: async (_number, payload) => {
      calls.push(['createReview', payload]);
      return { id: 1 };
    },
    reviewComments: async () => [],
    reply: async (...args) => calls.push(['reply', ...args]),
    issueComments: async () => [],
    createIssueComment: async (_number, body) => {
      calls.push(['createIssueComment', body]);
      return { id: 20 };
    },
    updateIssueComment: async (...args) =>
      calls.push(['updateIssueComment', ...args]),
    deleteIssueComment: async (...args) =>
      calls.push(['deleteIssueComment', ...args]),
    ...overrides,
  };
}

test('rejects an outcome that was produced for a different head', async () => {
  const api = fakeApi();
  await assert.rejects(
    publishCodeReview({
      api,
      prNumber: 10,
      expectedHeadSha: 'different',
      attemptId: 'attempt',
      result: result(),
    }),
    /outcome reviewed head, expected different/,
  );
  assert.equal(api.calls.length, 0);
});

test('records a superseded publication after the pull request head moves', async () => {
  const warnings = [];
  const api = fakeApi({
    pullRequest: async () => ({ head: { sha: 'new-head' } }),
  });
  const publication = await publishCodeReview({
    api,
    prNumber: 10,
    expectedHeadSha: 'head',
    attemptId: 'attempt',
    result: result(),
    log: { warn: (message) => warnings.push(message) },
  });
  assert.deepEqual(publication, {
    schemaVersion: 1,
    status: 'superseded',
    reviewedHeadSha: 'head',
    currentHeadSha: 'new-head',
  });
  assert.equal(api.calls.length, 0);
  assert.match(warnings[0], /no review was published/);
});

test('reuses a review already published by the same workflow run', async () => {
  const api = fakeApi({
    reviews: async () => [
      { id: 7, body: attemptMarker('attempt'), commit_id: 'head' },
    ],
  });
  const published = await publishCodeReview({
    api,
    prNumber: 10,
    expectedHeadSha: 'head',
    attemptId: 'attempt',
    result: result(),
  });
  assert.deepEqual(published, {
    schemaVersion: 1,
    status: 'reused',
    reviewId: 7,
  });
  assert.equal(api.calls.filter(([name]) => name === 'createReview').length, 0);
});

test('an idempotent retry still retries post-publication cleanup', async () => {
  const api = fakeApi({
    reviews: async () => [
      { id: 7, body: attemptMarker('attempt'), commit_id: 'head' },
    ],
    issueComments: async () => [
      {
        id: 30,
        body: `${FAILURE_MARKER}\nold failure`,
        user: { login: 'github-actions[bot]' },
      },
    ],
  });
  await publishCodeReview({
    api,
    prNumber: 10,
    expectedHeadSha: 'head',
    attemptId: 'attempt',
    result: result(),
  });
  assert.equal(
    api.calls.filter(([name]) => name === 'deleteIssueComment').length,
    1,
  );
});

test('does not reuse a workflow-run marker from a different head', async () => {
  const api = fakeApi({
    reviews: async () => [
      { body: attemptMarker('attempt'), commit_id: 'old-head' },
    ],
  });
  const published = await publishCodeReview({
    api,
    prNumber: 10,
    expectedHeadSha: 'head',
    attemptId: 'attempt',
    result: result(),
  });
  assert.equal(published.status, 'published');
  assert.equal(published.reviewId, 1);
  assert.equal(api.calls.filter(([name]) => name === 'createReview').length, 1);
});

test('refreshes the pull-request head immediately before publication', async () => {
  let reads = 0;
  const api = fakeApi({
    pullRequest: async () => {
      reads++;
      return { head: { sha: reads === 1 ? 'head' : 'new-head' } };
    },
  });

  const published = await publishCodeReview({
    api,
    prNumber: 10,
    expectedHeadSha: 'head',
    attemptId: 'attempt',
    result: result(),
    log: { warn: () => {} },
  });

  assert.equal(published.status, 'superseded');
  assert.equal(published.currentHeadSha, 'new-head');
  assert.equal(api.calls.filter(([name]) => name === 'createReview').length, 0);
});

test('falls back to a summary-only review when GitHub rejects an inline line', async () => {
  let attempts = 0;
  const api = fakeApi({
    files: async () => [
      { filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' },
    ],
    createReview: async (_number, payload) => {
      attempts++;
      if (attempts === 1) {
        throw new GitHubApiError(
          'POST',
          '/reviews',
          422,
          JSON.stringify({
            message: 'Validation Failed',
            errors: [
              {
                resource: 'PullRequestReviewComment',
                field: 'line',
                code: 'custom',
              },
            ],
          }),
        );
      }
      api.calls.push(['createReview', payload]);
      return { id: 2 };
    },
  });
  const reviewResult = result({
    findings: [
      {
        id: 'finding-1',
        title: 'Check this',
        body: 'This line is unsafe.',
        severity: 'major',
        evidence: [],
        lensRefs: [],
        disposition: 'new',
        location: { path: 'src/a.ts', line: 1, side: 'RIGHT' },
      },
    ],
  });
  const published = await publishCodeReview({
    api,
    prNumber: 10,
    expectedHeadSha: 'head',
    attemptId: 'attempt',
    result: reviewResult,
  });
  assert.equal(published.usedFallback, true);
  assert.equal(published.reviewId, 2);
  assert.equal(api.calls[0][1].comments.length, 0);
  assert.match(
    api.calls[0][1].body,
    /Additional findings outside changed lines/,
  );
  // The body GitHub actually accepted must report the finding as unplaced: it
  // was rendered into the body, not onto a thread.
  assert.match(
    api.calls[0][1].body,
    /<!-- tessl-code-review:result:v1 approved=false findings-total=1 findings-unplaced=1 -->/,
  );
});

test('keeps an advisory review successful when conversation cleanup fails', async () => {
  const warnings = [];
  const api = fakeApi({
    reviewComments: async () => {
      throw new Error('secondary API unavailable');
    },
  });
  const published = await publishCodeReview({
    api,
    prNumber: 10,
    expectedHeadSha: 'head',
    attemptId: 'attempt',
    result: result(),
    log: { warn: (message) => warnings.push(message) },
  });
  assert.equal(published.status, 'published');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /conversation replies were incomplete/);
});

test('a gate run does not describe its review as advisory', async () => {
  const warnings = [];
  const api = fakeApi({
    reviewComments: async () => {
      throw new Error('secondary API unavailable');
    },
  });
  await publishCodeReview({
    api,
    prNumber: 10,
    expectedHeadSha: 'head',
    attemptId: 'attempt',
    result: result({ approved: true }),
    reviewEvent: 'APPROVE',
    mode: 'gate',
    log: { warn: (message) => warnings.push(message) },
  });

  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /advisory/i);
  assert.match(warnings[0], /^The gate review was published/);
});

test('publishes the requested GitHub review event', async () => {
  const api = fakeApi();
  const published = await publishCodeReview({
    api,
    prNumber: 10,
    expectedHeadSha: 'head',
    attemptId: 'attempt',
    result: result({ approved: true }),
    reviewEvent: 'APPROVE',
  });

  assert.equal(api.calls[0][1].event, 'APPROVE');
  assert.equal(published.intendedEvent, 'APPROVE');
  assert.equal(published.publishedEvent, 'APPROVE');
});

test('preserves a completed review as a comment when approval is forbidden', async () => {
  let attempts = 0;
  const api = fakeApi({
    createReview: async (_number, payload) => {
      attempts++;
      api.calls.push(['createReview', payload]);
      if (attempts === 1) {
        throw new GitHubApiError(
          'POST',
          '/reviews',
          403,
          JSON.stringify({ message: 'GitHub Actions is not permitted to approve pull requests' }),
        );
      }
      return { id: 2 };
    },
  });

  const published = await publishCodeReview({
    api,
    prNumber: 10,
    expectedHeadSha: 'head',
    attemptId: 'attempt',
    result: result({ approved: true }),
    reviewEvent: 'APPROVE',
  });

  assert.equal(api.calls[0][1].event, 'APPROVE');
  assert.equal(api.calls[1][1].event, 'COMMENT');
  assert.match(api.calls[1][1].body, /did not allow the workflow to approve/);
  assert.deepEqual(published, {
    schemaVersion: 1,
    status: 'published-with-policy-fallback',
    reviewId: 2,
    intendedEvent: 'APPROVE',
    publishedEvent: 'COMMENT',
    reason: 'review-event-not-permitted',
    inlineCount: 0,
    unplacedCount: 0,
    usedFallback: false,
    reconciled: false,
  });
});

test('reconciles an accepted review after an ambiguous POST failure', async () => {
  let reviewReads = 0;
  const api = fakeApi({
    reviews: async () => {
      reviewReads++;
      return reviewReads === 1
        ? []
        : [
            {
              id: 9,
              body: attemptMarker('attempt'),
              commit_id: 'head',
            },
          ];
    },
    createReview: async () => {
      throw new TypeError('connection reset after request upload');
    },
  });

  const published = await publishCodeReview({
    api,
    prNumber: 10,
    expectedHeadSha: 'head',
    attemptId: 'attempt',
    result: result({ approved: true }),
    reviewEvent: 'APPROVE',
  });

  assert.equal(reviewReads, 2);
  assert.equal(published.status, 'published');
  assert.equal(published.reviewId, 9);
  assert.equal(published.reconciled, true);
});

test('preserves the original ambiguous error when reconciliation is inconclusive', async () => {
  const original = new TypeError('connection reset after request upload');
  const api = fakeApi({
    createReview: async () => {
      throw original;
    },
    reviews: async () => [],
  });

  await assert.rejects(
    publishCodeReview({
      api,
      prNumber: 10,
      expectedHeadSha: 'head',
      attemptId: 'attempt',
      result: result(),
    }),
    (error) => error === original,
  );
});

test('rejects an unsupported GitHub review event before calling the API', async () => {
  const api = fakeApi();
  await assert.rejects(
    publishCodeReview({
      api,
      prNumber: 10,
      expectedHeadSha: 'head',
      attemptId: 'attempt',
      result: result(),
      reviewEvent: 'DISMISS',
    }),
    /Unsupported GitHub review event/,
  );
  assert.equal(api.calls.length, 0);
});

test('failure notice is stable and a successful retry removes it', async () => {
  const existing = {
    id: 30,
    body: `${FAILURE_MARKER}\nold failure`,
    user: { login: 'github-actions[bot]' },
  };
  const api = fakeApi({ issueComments: async () => [existing] });
  const failure = await publishFailureNotice({
    api,
    prNumber: 10,
    runUrl: 'https://github.com/run/1',
  });
  assert.equal(failure.status, 'updated');
  assert.equal(
    api.calls.filter(([name]) => name === 'updateIssueComment').length,
    1,
  );

  const removed = await removeFailureNotices({ api, prNumber: 10 });
  assert.equal(removed, 1);
  assert.equal(
    api.calls.filter(([name]) => name === 'deleteIssueComment').length,
    1,
  );
});

test('creates a failure notice rather than editing a human marker', async () => {
  const api = fakeApi({
    issueComments: async () => [
      {
        id: 30,
        body: `${FAILURE_MARKER}\nhuman text`,
        user: { login: 'developer' },
      },
    ],
  });
  const failure = await publishFailureNotice({
    api,
    prNumber: 10,
    runUrl: 'https://github.com/run/1',
  });
  assert.equal(failure.status, 'created');
  assert.equal(
    api.calls.filter(([name]) => name === 'createIssueComment').length,
    1,
  );
});

test('answers a still-applying prior whose thread ends on a fix claim', async () => {
  const api = fakeApi({
    files: async () => [
      {
        filename: 'new.ts',
        patch: ['@@ -1,2 +1,2 @@', ' unchanged', '-old', '+new'].join('\n'),
      },
    ],
    reviewComments: async () => [
      {
        id: 10,
        body: '<!-- tessl-code-review:finding:v1 id=prior-1 -->',
        user: { login: 'github-actions[bot]', type: 'Bot' },
      },
      {
        id: 11,
        in_reply_to_id: 10,
        body: 'Fixed in a8dbcc5.',
        user: { login: 'developer', type: 'User' },
      },
      {
        id: 12,
        in_reply_to_id: 10,
        body: 'Still applies after re-review.',
        user: { login: 'github-actions[bot]', type: 'Bot' },
      },
      {
        id: 13,
        in_reply_to_id: 10,
        body: 'Fixed in 7d734df.',
        user: { login: 'developer', type: 'User' },
      },
    ],
  });
  await publishCodeReview({
    api,
    prNumber: 10,
    expectedHeadSha: 'head',
    attemptId: 'attempt',
    result: result({
      judgement: 'Two concerns remain.',
      findings: [
        {
          id: 'finding-carried',
          title: 'Provide a safe restore procedure',
          body: 'The lookup cannot tell an absent ruleset from a failed call.',
          severity: 'major',
          disposition: 'remaining',
          location: { path: 'README.md', line: 2, side: 'RIGHT' },
        },
        {
          id: 'finding-raised',
          title: 'Do not delete every overlapping ruleset',
          body: 'Deleting by pattern can remove an unrelated policy.',
          severity: 'major',
          location: { path: 'new.ts', line: 2, side: 'RIGHT' },
        },
      ],
      reconciliation: [
        {
          category: 'remaining',
          findingId: 'finding-carried',
          priorFindingId: 'prior-1',
        },
      ],
    }),
  });

  const [, payload] = api.calls.find(([name]) => name === 'createReview');
  assert.match(payload.body, /### Changes requested \(2\)/);
  assert.match(payload.body, /\| Major \| 2 \|/);
  assert.match(payload.body, /Provide a safe restore procedure/);
  assert.match(payload.body, /Do not delete every overlapping ruleset/);
  assert.equal(payload.comments.length, 1);

  const replies = api.calls.filter(([name]) => name === 'reply');
  assert.equal(replies.length, 1);
  assert.equal(replies[0][2], 10);
  assert.match(replies[0][3], /Still applies after re-review\./);
});

test('replies to a user-participated earlier finding after publication', async () => {
  const api = fakeApi({
    reviewComments: async () => [
      {
        id: 10,
        body: '<!-- tessl-code-review:finding:v1 id=prior-1 -->',
        user: { login: 'github-actions[bot]', type: 'Bot' },
      },
      {
        id: 11,
        in_reply_to_id: 10,
        body: 'This is intentional.',
        user: { login: 'developer', type: 'User' },
      },
    ],
  });
  await publishCodeReview({
    api,
    prNumber: 10,
    expectedHeadSha: 'head',
    attemptId: 'attempt',
    result: result({
      reconciliation: [
        {
          category: 'explained',
          priorFindingId: 'prior-1',
          note: 'The reply explains the invariant.',
        },
      ],
    }),
  });
  assert.equal(api.calls.filter(([name]) => name === 'reply').length, 1);
});
