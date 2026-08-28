import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = new URL('../src/finalize.mjs', import.meta.url).pathname;
const stub = new URL('./stub-github-fetch.mjs', import.meta.url).pathname;

async function finalize({
  mode = 'gate',
  checkRunId,
  approved = true,
  result,
  publication = { status: 'published' },
  reviewExitCode = '0',
  prNumber = '42',
  commentId,
  headSha,
  reviewOutput,
  writableOutputs = true,
}) {
  const directory = await mkdtemp(join(tmpdir(), 'code-review-action-test-'));
  const outputs = join(directory, 'outputs');
  const requests = join(directory, 'requests');
  await writeFile(
    join(directory, 'result.json'),
    result ??
      JSON.stringify({
        status: 'ok',
        outcome: { approved },
        ...(publication === undefined ? {} : { publication }),
      }),
  );
  await writeFile(outputs, '');
  await writeFile(requests, '');

  try {
    const completed = await run(
      process.execPath,
      ['--import', stub, script],
      {
        env: {
          PATH: process.env.PATH,
          GH_TOKEN: 'token',
          REPOSITORY: 'acme/widgets',
          RUN_URL: 'https://github.example/run/1',
          MODE: mode,
          REVIEW_EXIT_CODE: reviewExitCode,
          PR_NUMBER: prNumber,
          ...(commentId === undefined ? {} : { COMMENT_ID: commentId }),
          ...(headSha === undefined ? {} : { HEAD_SHA: headSha }),
          REVIEW_OUTPUT:
            reviewOutput === undefined
              ? join(directory, 'result.json')
              : reviewOutput,
          GITHUB_OUTPUT: writableOutputs
            ? outputs
            : join(directory, 'absent', 'outputs'),
          REQUEST_LOG: requests,
          ...(checkRunId === undefined ? {} : { CHECK_RUN_ID: checkRunId }),
        },
      },
    ).catch((error) => error);
    return {
      exitCode: completed.code ?? 0,
      stdout: completed.stdout ?? '',
      outputs: await readFile(outputs, 'utf8'),
      requests: (await readFile(requests, 'utf8')).trim(),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('carries requested changes on the check run, not the job', async () => {
  const { exitCode, outputs, requests } = await finalize({
    checkRunId: '987654',
    approved: false,
  });

  assert.equal(exitCode, 0);
  assert.match(outputs, /status=changes-requested/);
  assert.match(requests, /PATCH .*\/check-runs\/987654/);
  assert.match(requests, /"conclusion":"failure"/);
});

test('sends no check-run request when no check run was created', async () => {
  const { exitCode, outputs, requests } = await finalize({ checkRunId: '' });

  assert.equal(exitCode, 0);
  assert.match(outputs, /status=approved/);
  assert.doesNotMatch(requests, /check-runs/);
});

test('sends no check-run request when the step output is absent', async () => {
  const { requests } = await finalize({ checkRunId: undefined });

  assert.doesNotMatch(requests, /check-runs/);
});

test('reports an unreadable result as a review failure without a second annotation', async () => {
  for (const result of ['not json', '', '   \n']) {
    const { exitCode, stdout, outputs, requests } = await finalize({
      checkRunId: '987654',
      result,
    });

    assert.notEqual(exitCode, 0);
    assert.match(outputs, /status=technical-failure/);
    // The publish step annotated the same file, so this one does not repeat it.
    assert.doesNotMatch(stdout, /::error::/);
    assert.match(requests, /PATCH .*\/check-runs\/987654/);
    assert.match(requests, /"conclusion":"failure"/);
  }
});

test('the check run names the configuration that stopped the review', async () => {
  const { exitCode, outputs, requests } = await finalize({
    checkRunId: '987654',
    reviewExitCode: '1',
    result: JSON.stringify({
      status: 'failed',
      failure: {
        stage: 'validation',
        kind: 'invalid-profile-file',
        message:
          'Invalid Code Review profile "./.tessl-code-review.yml": Lens ref "./review-lenses/gone/SKILL.md" does not resolve to a readable path.',
      },
      diagnostics: { durationMs: 35 },
    }),
  });

  assert.notEqual(exitCode, 0);
  assert.match(outputs, /status=technical-failure/);
  assert.match(requests, /does not resolve to a readable path/);
  // The status sentence stays: the reason follows it rather than replacing it.
  assert.match(requests, /Review did not complete/);
});

test('the check run withholds a failure message from the executor', async () => {
  const { requests } = await finalize({
    checkRunId: '987654',
    reviewExitCode: '1',
    result: JSON.stringify({
      status: 'failed',
      failure: {
        stage: 'execution',
        kind: 'executor-error',
        message: 'a sentence quoting the reviewed source',
      },
      diagnostics: { durationMs: 35 },
    }),
  });

  assert.doesNotMatch(requests, /reviewed source/);
  assert.match(requests, /Open the workflow run for details/);
});

test('a superseded run explains itself in the run and the check', async () => {
  const { exitCode, stdout, outputs, requests } = await finalize({
    checkRunId: '987654',
    publication: { status: 'superseded' },
  });

  assert.equal(exitCode, 1);
  assert.match(outputs, /status=superseded/);
  assert.match(stdout, /^::warning::.*no review was published/m);
  assert.equal(stdout.trim().split('\n').length, 1);
  assert.doesNotMatch(stdout, /ai-notice:v1/);
  assert.match(requests, /"conclusion":"neutral"/);
  assert.match(requests, /reviews the newer commit/);
});

test('a no-match result succeeds without publishing or asserting a verdict', async () => {
  const { exitCode, outputs, requests } = await finalize({
    mode: 'gate',
    checkRunId: '987654',
    result: JSON.stringify({
      status: 'skipped',
      reason: 'no-matching-lenses',
      diagnostics: { durationMs: 12 },
    }),
    publication: undefined,
  });

  assert.equal(exitCode, 0);
  assert.match(outputs, /status=skipped-no-matching-lenses/);
  assert.match(requests, /"conclusion":"neutral"/);
  assert.doesNotMatch(requests, /"conclusion":"success"/);
});

test('a refused approval request answers the comment that asked', async () => {
  const { exitCode, outputs, requests } = await finalize({
    mode: 'gate',
    checkRunId: '987654',
    commentId: '55',
    result: JSON.stringify({
      status: 'skipped',
      reason: 'approval-not-permitted',
      diagnostics: { durationMs: 12 },
    }),
    publication: undefined,
  });

  assert.equal(exitCode, 0);
  assert.match(outputs, /status=refused-approval-request/);
  assert.match(requests, /"conclusion":"neutral"/);
  assert.doesNotMatch(requests, /"conclusion":"success"/);
  // The run made no review, so this comment is the only thing that reaches the
  // pull request: without it the commenter sees a neutral check and no reason.
  assert.match(requests, /issues\/42\/comments/);
  assert.match(requests, /tessl-code-review:approval-refused:v1 id=55/);
  assert.match(requests, /Approval request refused, and no review was run/);
  // Same contract as the check-run summary: who may approve, the exception a
  // caller can configure, and how to get a review instead.
  assert.match(requests, /owners, members, and collaborators/);
  assert.match(requests, /approver-logins/);
  assert.match(requests, /@tessl-code-review/);
});

test('a refused approval request with no comment id still concludes', async () => {
  // A workflow_dispatch or pull_request run carries no comment to answer, and
  // the conclusion does not depend on one landing.
  const { exitCode, outputs, requests } = await finalize({
    checkRunId: '987654',
    result: JSON.stringify({
      status: 'skipped',
      reason: 'approval-not-permitted',
      diagnostics: { durationMs: 12 },
    }),
    publication: undefined,
  });

  assert.equal(exitCode, 0);
  assert.match(outputs, /status=refused-approval-request/);
  assert.doesNotMatch(requests, /approval-refused/);
});

test('concludes the check run when the step output cannot be written', async () => {
  const { exitCode, requests } = await finalize({
    checkRunId: '987654',
    approved: false,
    writableOutputs: false,
  });

  assert.notEqual(exitCode, 0);
  assert.match(requests, /PATCH .*\/check-runs\/987654/);
  assert.match(requests, /"conclusion":"failure"/);
});

test('a completed review clears a stale notice even when it requests changes', async () => {
  // Completion is not approval: a gate publishing requested changes concludes
  // non-zero by design, and the notice saying it did not complete is false.
  const { requests } = await finalize({ mode: 'gate', approved: false });
  assert.match(requests, /\/issues\/42\/comments/);
});

test('a nonzero CLI invocation keeps its notice despite a published receipt', async () => {
  // The CLI can write a published receipt and still fail afterwards. Clearing
  // then would delete the notice posted for that very failure.
  const { outputs, requests } = await finalize({
    mode: 'gate',
    reviewExitCode: '1',
  });
  assert.match(outputs, /status=publication-failure/);
  assert.doesNotMatch(requests, /\/issues\/42\/comments/);
});

test('a verdict for another commit keeps the notice that says so', async () => {
  // Concluded superseded, so the run did not complete a review for this head
  // even though the CLI exited zero with a published receipt.
  const { outputs, requests } = await finalize({
    result: JSON.stringify({
      status: 'ok',
      outcome: { approved: true, subject: { change: { headRevision: 'other' } } },
      publication: { status: 'published' },
    }),
    headSha: 'expected',
  });
  assert.match(outputs, /status=superseded/);
  assert.doesNotMatch(requests, /\/issues\/42\/comments/);
});

test('a review step that never ran concludes rather than crashing', async () => {
  // A skipped step leaves its outputs empty, not unset. Treating that as a
  // path to open threw before the check run could be concluded cleanly.
  const { exitCode, outputs, requests } = await finalize({
    reviewExitCode: '',
    reviewOutput: '',
    checkRunId: '987654',
  });

  assert.equal(exitCode, 1);
  assert.match(outputs, /status=technical-failure/);
  assert.match(requests, /PATCH .*\/check-runs\/987654/);
});
