import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reviewConclusion } from '../src/conclusion.mjs';

/**
 * The CLI reports the review and what it did with it in one document, so a
 * publication receipt is built into the result rather than supplied beside it.
 */
const valid = ({ outcome, publication, ...overrides } = {}) => ({
  mode: 'advisory',
  reviewExitCode: '0',
  result: {
    status: 'ok',
    outcome: outcome === undefined ? { approved: true } : outcome,
    // `null` states that the run published nothing, which the CLI reports by
    // omitting the field rather than by writing an empty one.
    ...(publication === null
      ? {}
      : { publication: publication ?? { status: 'published' } }),
  },
  ...overrides,
});

test('advisory findings remain successful', () => {
  assert.deepEqual(
    reviewConclusion(
      valid({ outcome: { approved: false } }),
    ),
    { status: 'advisory-findings', exitCode: 0 },
  );
});

test('an unapproved gate fails after requesting changes', () => {
  assert.deepEqual(
    reviewConclusion(
      valid({ mode: 'gate', outcome: { approved: false } }),
    ),
    { status: 'changes-requested', exitCode: 1 },
  );
});

test('an approved gate succeeds', () => {
  assert.deepEqual(reviewConclusion(valid({ mode: 'gate' })), {
    status: 'approved',
    exitCode: 0,
  });
});

test('a gate without a boolean verdict fails instead of passing the head', () => {
  for (const outcome of [{}, { approved: 'false' }, { approved: 'true' }, { approved: null }]) {
    assert.deepEqual(
      reviewConclusion(valid({ mode: 'gate', outcome })),
      { status: 'gate-verdict-failure', exitCode: 1 },
    );
  }
  assert.deepEqual(reviewConclusion(valid({ mode: 'gate', outcome: {} })), {
    status: 'gate-verdict-failure',
    exitCode: 1,
  });
});

test('a review that produced an outcome but exited nonzero failed to publish', () => {
  // The CLI reports reviewing and publishing through one exit code, so the
  // outcome is what separates them: a maintainer sent to the review instead of
  // the permission that stopped publication looks in the wrong place.
  assert.deepEqual(
    reviewConclusion(valid({ mode: 'gate', reviewExitCode: '1' })),
    { status: 'publication-failure', exitCode: 1 },
  );
});

test('a review that produced no outcome is a technical failure', () => {
  assert.deepEqual(
    reviewConclusion({
      mode: 'gate',
      reviewExitCode: '1',
      result: { status: 'failed', failure: { kind: 'internal' } },
    }),
    { status: 'technical-failure', exitCode: 1 },
  );
});

test('a review that published nothing reports a publication failure', () => {
  assert.deepEqual(reviewConclusion(valid({ publication: null })), {
    status: 'publication-failure',
    exitCode: 1,
  });
});

test('only a boolean true reads as approval', () => {
  for (const mode of ['advisory', 'gate']) {
    assert.notEqual(
      reviewConclusion(
        valid({ mode, outcome: { approved: 'true' } }),
      ).status,
      'approved',
    );
  }
});

test('advisory still succeeds when the outcome carries no verdict', () => {
  assert.deepEqual(reviewConclusion(valid({ outcome: {} })), {
    status: 'advisory-findings',
    exitCode: 0,
  });
});

test('a successful no-match result is neutral and does not require publication', () => {
  for (const mode of ['advisory', 'gate']) {
    assert.deepEqual(
      reviewConclusion(
        valid({
          mode,
          result: {
            status: 'skipped',
            reason: 'no-matching-lenses',
            diagnostics: { durationMs: 12 },
          },
        }),
      ),
      { status: 'skipped-no-matching-lenses', exitCode: 0 },
    );
  }
});

test('a comment fallback fails distinctly from review findings', () => {
  assert.deepEqual(
    reviewConclusion(
      valid({
        mode: 'gate',
        publication: { status: 'published-with-policy-fallback' },
      }),
    ),
    { status: 'gate-configuration-failure', exitCode: 1 },
  );
});

test('technical, publication and stale-head failures have stable statuses', () => {
  assert.deepEqual(
    reviewConclusion({
      mode: 'advisory',
      reviewExitCode: '2',
      result: { status: 'failed', failure: { kind: 'internal' } },
    }),
    { status: 'technical-failure', exitCode: 1 },
  );
  assert.deepEqual(
    reviewConclusion(valid({ publication: { status: 'superseded' } })),
    { status: 'superseded', exitCode: 1 },
  );
});
