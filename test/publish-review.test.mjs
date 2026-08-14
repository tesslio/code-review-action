import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = new URL('../src/publish-review.mjs', import.meta.url).pathname;
const stub = new URL('./stub-github-fetch.mjs', import.meta.url).pathname;

async function publish({ result }) {
  const directory = await mkdtemp(join(tmpdir(), 'code-review-action-test-'));
  const resultPath = join(directory, 'result.json');
  const requests = join(directory, 'requests');
  await writeFile(resultPath, result, 'utf8');
  await writeFile(requests, '');

  try {
    const completed = await run(process.execPath, ['--import', stub, script], {
      env: {
        PATH: process.env.PATH,
        GH_TOKEN: 'token',
        REPOSITORY: 'acme/widgets',
        PR_NUMBER: '10',
        HEAD_SHA: 'a'.repeat(40),
        MODE: 'gate',
        GITHUB_RUN_ID: 'workflow-1',
        REVIEW_OUTPUT: resultPath,
        REQUEST_LOG: requests,
      },
    }).catch((error) => error);
    return {
      exitCode: completed.code ?? 0,
      stdout: completed.stdout ?? '',
      stderr: completed.stderr ?? '',
      requests: (await readFile(requests, 'utf8')).trim(),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a no-match result is a successful no-op without GitHub publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-review-action-test-'));
  const resultPath = join(directory, 'result.json');
  const publicationPath = join(directory, 'publication.json');
  const outputs = join(directory, 'outputs');
  const requests = join(directory, 'requests');
  await writeFile(
    resultPath,
    JSON.stringify({ status: 'skipped', reason: 'no-matching-lenses' }),
    'utf8',
  );
  await writeFile(requests, '');
  await writeFile(outputs, '');

  try {
    const completed = await run(process.execPath, ['--import', stub, script], {
      env: {
        PATH: process.env.PATH,
        GH_TOKEN: 'token',
        REPOSITORY: 'acme/widgets',
        PR_NUMBER: '10',
        HEAD_SHA: 'a'.repeat(40),
        MODE: 'gate',
        GITHUB_RUN_ID: 'workflow-1',
        REVIEW_OUTPUT: resultPath,
        PUBLISH_OUTPUT: publicationPath,
        GITHUB_OUTPUT: outputs,
        REQUEST_LOG: requests,
      },
    });

    assert.equal(completed.code ?? 0, 0);
    assert.equal((await readFile(requests, 'utf8')).trim(), '');
    assert.deepEqual(JSON.parse(await readFile(publicationPath, 'utf8')), {
      schemaVersion: 1,
      status: 'skipped-no-matching-lenses',
    });
    assert.match(
      await readFile(outputs, 'utf8'),
      /publication-status=skipped-no-matching-lenses/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an empty result file fails as a result problem, not a publication one', async () => {
  const { exitCode, stdout, requests } = await publish({ result: '' });

  assert.notEqual(exitCode, 0);
  assert.match(stdout, /^::error::/m);
  assert.match(stdout, /result file .* is empty/);
  assert.equal(requests, '');
});

test('a whitespace-only result file names the missing result', async () => {
  const { exitCode, stdout, requests } = await publish({ result: '  \n\t\n' });

  assert.notEqual(exitCode, 0);
  assert.match(stdout, /result file .* is empty/);
  assert.equal(requests, '');
});

test('a malformed result file names the parse problem', async () => {
  const { exitCode, stdout, requests } = await publish({
    result: '{"status":"ok",',
  });

  assert.notEqual(exitCode, 0);
  assert.match(stdout, /^::error::/m);
  assert.match(stdout, /is not valid JSON/);
  assert.equal(requests, '');
});

test('a missing result file names the file that could not be read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-review-action-test-'));
  try {
    const completed = await run(process.execPath, ['--import', stub, script], {
      env: {
        PATH: process.env.PATH,
        GH_TOKEN: 'token',
        REPOSITORY: 'acme/widgets',
        PR_NUMBER: '10',
        HEAD_SHA: 'a'.repeat(40),
        MODE: 'gate',
        GITHUB_RUN_ID: 'workflow-1',
        REVIEW_OUTPUT: join(directory, 'absent.json'),
        REQUEST_LOG: join(directory, 'requests'),
      },
    }).catch((error) => error);

    assert.notEqual(completed.code ?? 0, 0);
    assert.match(completed.stdout ?? '', /could not be read/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
