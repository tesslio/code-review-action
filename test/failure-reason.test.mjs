import assert from 'node:assert/strict';
import { test } from 'node:test';

import { configurationFailureReason } from '../src/failure-reason.mjs';

function failed(failure) {
  return { status: 'failed', failure, diagnostics: { durationMs: 35 } };
}

test('quotes the reason a run stopped on its own configuration', () => {
  assert.equal(
    configurationFailureReason(
      failed({
        stage: 'validation',
        kind: 'invalid-profile-file',
        message:
          'Invalid Code Review profile "./.tessl-code-review.yml": Lens ref "./review-lenses/gone/SKILL.md" does not resolve to a readable path.',
      }),
    ),
    'Invalid Code Review profile "./.tessl-code-review.yml": Lens ref "./review-lenses/gone/SKILL.md" does not resolve to a readable path.',
  );
});

test('withholds a message that can carry model output or a provider response', () => {
  for (const failure of [
    { stage: 'execution', kind: 'executor-error', message: 'reviewed source' },
    { stage: 'internal', kind: 'unexpected-error', message: 'a stack trace' },
    { stage: 'preparation', kind: 'provider-error', message: 'a response body' },
  ]) {
    assert.equal(configurationFailureReason(failed(failure)), undefined);
  }
});

test('withholds a stage this revision does not recognize', () => {
  assert.equal(
    configurationFailureReason(
      failed({ stage: 'a-later-stage', kind: 'whatever', message: 'text' }),
    ),
    undefined,
  );
});

test('has nothing to quote for a result that did not fail', () => {
  for (const result of [
    undefined,
    { status: 'ok', outcome: { approved: true } },
    { status: 'skipped', reason: 'no-matching-lenses' },
    { status: 'failed' },
    { status: 'failed', failure: null },
    { status: 'failed', failure: 'invalid-profile-file' },
    failed({ stage: 'validation', kind: 'invalid-request' }),
    failed({ stage: 'validation', kind: 'invalid-request', message: '   ' }),
  ]) {
    assert.equal(configurationFailureReason(result), undefined);
  }
});

test('renders as one line that cannot escape a code span', () => {
  const reason = configurationFailureReason(
    failed({
      stage: 'profile',
      kind: 'unknown-profile',
      message:
        'Unknown profile `rogue`\n\n</summary>**bold**\r\nsecond line.',
    }),
  );

  assert.doesNotMatch(reason, /[\n\r`]/u);
  assert.match(reason, /Unknown profile 'rogue'/);
});

test('truncates a message too long to be a configuration sentence', () => {
  const reason = configurationFailureReason(
    failed({
      stage: 'credit',
      kind: 'insufficient-credit',
      message: 'x'.repeat(2000),
    }),
  );

  assert.equal(reason.length, 500);
  assert.match(reason, /…$/u);
});
