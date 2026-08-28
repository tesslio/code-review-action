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

test('withholds every kind outside the allowlist, whatever its stage', () => {
  for (const failure of [
    { stage: 'model-validation', kind: 'unusable-model', message: 'a list' },
    { stage: 'executor-selection', kind: 'unknown-executor', message: 'a list' },
    { stage: 'profile', kind: 'lens-resolution', message: 'a resolver error' },
    { stage: 'preparation', kind: 'provider-error', message: 'a response body' },
    { stage: 'execution', kind: 'executor-error', message: 'a review' },
    { stage: 'internal', kind: 'unexpected-error', message: 'a stack trace' },
  ]) {
    assert.equal(configurationFailureReason(failed(failure)), undefined);
  }
});

test('withholds a kind this revision does not name', () => {
  assert.equal(
    configurationFailureReason(
      failed({ stage: 'validation', kind: 'a-later-kind', message: 'text' }),
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

test('strips formatting controls that reorder what a reader sees', () => {
  const override = String.fromCodePoint(0x202e);
  const isolate = String.fromCodePoint(0x2066);
  const reason = configurationFailureReason(
    failed({
      stage: 'validation',
      kind: 'invalid-profile-file',
      message: `Could not read "${override}gpj.exe${isolate}" from the profile.`,
    }),
  );

  assert.doesNotMatch(reason, /\p{Cf}/u);
  assert.match(reason, /Could not read "gpj\.exe" from the profile\./);
});

test('truncates a message too long to be a configuration sentence', () => {
  const reason = configurationFailureReason(
    failed({
      stage: 'validation',
      kind: 'invalid-request',
      message: 'x'.repeat(2000),
    }),
  );

  assert.equal(reason.length, 500);
  assert.match(reason, /…$/u);
});
