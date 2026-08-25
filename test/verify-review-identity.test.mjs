import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = new URL('../src/verify-review-identity.mjs', import.meta.url)
  .pathname;
const stub = new URL('./stub-configured-github-fetch.mjs', import.meta.url)
  .pathname;

async function verify({ status = '200', body = '{}' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'code-review-action-test-'));
  const requests = join(directory, 'requests');
  await writeFile(requests, '');

  try {
    const completed = await run(process.execPath, ['--import', stub, script], {
      env: {
        PATH: process.env.PATH,
        GH_TOKEN: 'token',
        REPOSITORY: 'acme/widgets',
        REQUEST_LOG: requests,
        RESPONSE_STATUS: status,
        RESPONSE_BODY: body,
      },
    }).catch((error) => error);
    return {
      exitCode: completed.code ?? 0,
      stderr: completed.stderr ?? '',
      requests: (await readFile(requests, 'utf8')).trim(),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('admits a token that can reach the repository, asking once', async () => {
  const { exitCode, requests } = await verify({
    body: JSON.stringify({ permissions: { push: true, pull: true } }),
  });

  assert.equal(exitCode, 0);
  assert.equal(requests, 'GET https://api.github.com/repos/acme/widgets');
});

test('refuses a token GitHub rejects, naming the input', async () => {
  const { exitCode, stderr } = await verify({ status: '401' });

  assert.notEqual(exitCode, 0);
  assert.match(stderr, /github-token/);
  assert.match(stderr, /401/);
});

test('refuses a token that cannot see the repository, naming installation', async () => {
  const { exitCode, stderr } = await verify({ status: '404' });

  assert.notEqual(exitCode, 0);
  assert.match(stderr, /installed on this repository/);
});

test('admits a token GitHub reports no content write for', async () => {
  // `permissions.push` describes content write, not the pull-request write a
  // review needs. A fine-grained token holding exactly what this Action asks
  // for reports `push: false`, so refusing on it would refuse the recommended
  // configuration. Authorization is the review endpoint's to answer.
  const { exitCode } = await verify({
    body: JSON.stringify({ permissions: { push: false, pull: true } }),
  });

  assert.equal(exitCode, 0);
});
