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
          REVIEW_EXIT_CODE: '0',
          REVIEW_OUTPUT: join(directory, 'result.json'),
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

test('concludes the check run with the terminal status', async () => {
  const { exitCode, outputs, requests } = await finalize({
    checkRunId: '987654',
    approved: false,
  });

  assert.equal(exitCode, 1);
  assert.match(outputs, /status=changes-requested/);
  assert.match(requests, /PATCH .*\/check-runs\/987654/);
  assert.match(requests, /"conclusion":"failure"/);
});

test('sends no check-run request when no check run was created', async () => {
  const { exitCode, outputs, requests } = await finalize({ checkRunId: '' });

  assert.equal(exitCode, 0);
  assert.match(outputs, /status=approved/);
  assert.equal(requests, '');
});

test('sends no check-run request when the step output is absent', async () => {
  const { requests } = await finalize({ checkRunId: undefined });

  assert.equal(requests, '');
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
