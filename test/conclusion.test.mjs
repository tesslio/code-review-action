import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reviewConclusion } from '../src/conclusion.mjs';

const valid = (overrides = {}) => ({
  mode: 'advisory',
  reviewExitCode: '0',
  publishExitCode: '0',
  result: { outcome: { approved: true } },
  publication: { status: 'published' },
  ...overrides,
});

test('advisory findings remain successful', () => {
  assert.deepEqual(
    reviewConclusion(
      valid({ result: { outcome: { approved: false } } }),
    ),
    { status: 'advisory-findings', exitCode: 0 },
  );
});

test('an unapproved gate fails after requesting changes', () => {
  assert.deepEqual(
    reviewConclusion(
      valid({ mode: 'gate', result: { outcome: { approved: false } } }),
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
      reviewConclusion(valid({ mode: 'gate', result: { outcome } })),
      { status: 'gate-verdict-failure', exitCode: 1 },
    );
  }
  assert.deepEqual(reviewConclusion(valid({ mode: 'gate', result: {} })), {
    status: 'gate-verdict-failure',
    exitCode: 1,
  });
});

test('a gate reports the missing verdict that stopped publication', () => {
  assert.deepEqual(
    reviewConclusion(
      valid({ mode: 'gate', publishExitCode: '1', result: { outcome: {} } }),
    ),
    { status: 'gate-verdict-failure', exitCode: 1 },
  );
});

test('a gate with a valid verdict still reports a failed publication', () => {
  assert.deepEqual(
    reviewConclusion(
      valid({
        mode: 'gate',
        publishExitCode: '1',
        result: { outcome: { approved: false } },
      }),
    ),
    { status: 'publication-failure', exitCode: 1 },
  );
});

test('only a boolean true reads as approval', () => {
  for (const mode of ['advisory', 'gate']) {
    assert.notEqual(
      reviewConclusion(
        valid({ mode, result: { outcome: { approved: 'true' } } }),
      ).status,
      'approved',
    );
  }
});

test('advisory still succeeds when the outcome carries no verdict', () => {
  assert.deepEqual(reviewConclusion(valid({ result: { outcome: {} } })), {
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
          publishExitCode: '',
          publication: undefined,
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
    reviewConclusion(valid({ reviewExitCode: '2' })),
    { status: 'technical-failure', exitCode: 1 },
  );
  assert.deepEqual(
    reviewConclusion(valid({ publishExitCode: '1' })),
    { status: 'publication-failure', exitCode: 1 },
  );
  assert.deepEqual(
    reviewConclusion(valid({ publication: { status: 'superseded' } })),
    { status: 'superseded', exitCode: 1 },
  );
});
