import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHECK_NAME,
  checkRunReport,
  concludeReviewCheckRun,
  startReviewCheckRun,
} from '../src/check-run.mjs';
import { reviewConclusion } from '../src/conclusion.mjs';
import { GitHubApiError } from '../src/github-api.mjs';

function recordingApi(behavior = {}) {
  const calls = [];
  return {
    calls,
    createCheckRun(payload) {
      calls.push({ method: 'create', payload });
      if (behavior.createError) throw behavior.createError;
      return { id: 4242 };
    },
    updateCheckRun(checkRunId, payload) {
      calls.push({ method: 'update', checkRunId, payload });
      if (behavior.updateError) throw behavior.updateError;
      return { id: checkRunId };
    },
  };
}

function collectingLog() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

test('gate mode blocks on requested changes and clears on approval', () => {
  assert.equal(
    checkRunReport({ mode: 'gate', status: 'approved' }).conclusion,
    'success',
  );
  assert.equal(
    checkRunReport({ mode: 'gate', status: 'changes-requested' }).conclusion,
    'failure',
  );
});

test('gate mode fails when the outcome carries no verdict', () => {
  const report = checkRunReport({ mode: 'gate', status: 'gate-verdict-failure' });
  assert.equal(report.conclusion, 'failure');
  assert.match(report.summary, /no approval verdict/);
});

test('the findings summary does not describe gate mode as advisory', () => {
  assert.match(
    checkRunReport({ mode: 'advisory', status: 'advisory-findings' }).summary,
    /Advisory mode does not block the pull request/,
  );
  assert.doesNotMatch(
    checkRunReport({ mode: 'gate', status: 'advisory-findings' }).summary,
    /Advisory mode/,
  );
});

test('a superseded summary explains the failure and what follows it', () => {
  const summary = checkRunReport({ mode: 'gate', status: 'superseded' }).summary;
  assert.match(summary, /no review was published/);
  assert.match(summary, /reviews the newer commit/);
});

test('gate mode fails for technical, publication and configuration failures', () => {
  for (const status of [
    'technical-failure',
    'publication-failure',
    'gate-configuration-failure',
    'gate-verdict-failure',
  ]) {
    assert.equal(checkRunReport({ mode: 'gate', status }).conclusion, 'failure');
  }
});

test('advisory mode never reports a blocking conclusion', () => {
  for (const status of [
    'approved',
    'advisory-findings',
    'changes-requested',
    'technical-failure',
    'publication-failure',
    'gate-configuration-failure',
    'gate-verdict-failure',
    'superseded',
  ]) {
    assert.notEqual(
      checkRunReport({ mode: 'advisory', status }).conclusion,
      'failure',
    );
  }
});

test('a superseded run asserts no verdict in either mode', () => {
  for (const mode of ['advisory', 'gate']) {
    assert.equal(
      checkRunReport({ mode, status: 'superseded' }).conclusion,
      'neutral',
    );
  }
});

test('a no-match run is neutral and never reports approval', () => {
  for (const mode of ['advisory', 'gate']) {
    const report = checkRunReport({
      mode,
      status: 'skipped-no-matching-lenses',
    });
    assert.equal(report.conclusion, 'neutral');
    assert.match(report.title, /No matching review lenses/);
    assert.match(report.summary, /no review assertion/);
  }
});

test('a refused approval request is neutral and never reports approval', () => {
  for (const mode of ['advisory', 'gate']) {
    const report = checkRunReport({
      mode,
      status: 'refused-approval-request',
    });
    // Neutral in gate mode too: nothing reviewed this commit, so holding the
    // pull request is the honest position rather than a passing check.
    assert.equal(report.conclusion, 'neutral');
    assert.match(report.title, /Approval request refused/);
    assert.match(report.summary, /No review was run/);
    assert.doesNotMatch(report.summary, /approved/);
  }
});

test('an unrecognized status concludes without a verdict', () => {
  assert.deepEqual(checkRunReport({ mode: 'gate', status: 'invented' }), {
    conclusion: 'neutral',
    title: 'Review status unrecognized',
    summary:
      'Tessl Code Review finished with a status this revision of the Action does not recognize. Open the workflow run for details.',
  });
});

test('every status the conclusion model produces has its own report', () => {
  const inputs = [
    { mode: 'advisory', reviewExitCode: '1' },
    { mode: 'advisory', publishExitCode: '1' },
    { mode: 'advisory', publication: { status: 'superseded' } },
    {
      mode: 'gate',
      publication: { status: 'published-with-policy-fallback' },
    },
    { mode: 'gate', result: { outcome: { approved: false } } },
    { mode: 'gate', result: { outcome: { approved: true } } },
    { mode: 'gate', result: { outcome: {} } },
    { mode: 'advisory', result: { outcome: { approved: false } } },
  ];

  for (const overrides of inputs) {
    const { status } = reviewConclusion({
      reviewExitCode: '0',
      publishExitCode: '0',
      result: { outcome: { approved: true } },
      publication: { status: 'published' },
      ...overrides,
    });
    assert.notEqual(
      checkRunReport({ mode: overrides.mode, status }).title,
      'Review status unrecognized',
      `status ${status} has no check-run report`,
    );
  }
});

test('an unsupported mode is rejected', () => {
  assert.throws(() => checkRunReport({ mode: 'audit', status: 'approved' }));
});

test('the check run starts in progress against the reviewed head', async () => {
  const api = recordingApi();
  const checkRunId = await startReviewCheckRun({
    api,
    headSha: 'a'.repeat(40),
    detailsUrl: 'https://github.example/run/1',
  });

  assert.equal(checkRunId, 4242);
  assert.deepEqual(api.calls[0].payload.name, CHECK_NAME);
  assert.equal(api.calls[0].payload.head_sha, 'a'.repeat(40));
  assert.equal(api.calls[0].payload.status, 'in_progress');
});

test('a missing checks permission degrades to a warning instead of an error', async () => {
  const api = recordingApi({
    createError: new GitHubApiError(
      'POST',
      '/check-runs',
      403,
      '{"message":"Resource not accessible by integration"}',
    ),
  });
  const log = collectingLog();

  const checkRunId = await startReviewCheckRun({
    api,
    headSha: 'b'.repeat(40),
    detailsUrl: 'https://github.example/run/2',
    log,
  });

  assert.equal(checkRunId, undefined);
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], /^::warning::/);
  assert.match(log.lines[0], /checks: write/);
});

test('a rate-limited 403 does not blame the caller permissions', async () => {
  const api = recordingApi({
    createError: new GitHubApiError(
      'POST',
      '/check-runs',
      403,
      '{"message":"API rate limit exceeded"}',
    ),
  });
  const log = collectingLog();

  await startReviewCheckRun({
    api,
    headSha: 'c'.repeat(40),
    detailsUrl: 'https://github.example/run/5',
    log,
  });

  assert.doesNotMatch(log.lines[0], /checks: write/);
  assert.match(log.lines[0], /rate limit/);
});

test('an unexpected check-run failure degrades to a notice instead of an error', async () => {
  const api = recordingApi({ updateError: new Error('network down') });
  const log = collectingLog();

  const report = await concludeReviewCheckRun({
    api,
    checkRunId: '4242',
    mode: 'gate',
    status: 'approved',
    detailsUrl: 'https://github.example/run/3',
    log,
  });

  assert.equal(report, undefined);
  assert.match(log.lines[0], /^::notice::/);
  assert.match(log.lines[0], /network down/);
});

test('concluding completes the started check run with the mapped conclusion', async () => {
  const api = recordingApi();

  const report = await concludeReviewCheckRun({
    api,
    checkRunId: '4242',
    mode: 'gate',
    status: 'changes-requested',
    detailsUrl: 'https://github.example/run/4',
  });

  assert.equal(report.conclusion, 'failure');
  assert.equal(api.calls[0].checkRunId, '4242');
  assert.equal(api.calls[0].payload.status, 'completed');
  assert.equal(api.calls[0].payload.conclusion, 'failure');
  assert.equal(api.calls[0].payload.output.title, 'Changes requested');
});
