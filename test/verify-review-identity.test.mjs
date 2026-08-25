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

test('admits a token with write access, asking once', async () => {
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

test('refuses a read-only token before the review runs', async () => {
  const { exitCode, stderr } = await verify({
    body: JSON.stringify({ permissions: { push: false, pull: true } }),
  });

  assert.notEqual(exitCode, 0);
  assert.match(stderr, /read-only/);
  assert.match(stderr, /pull-requests write/);
});

test('admits a token whose permissions GitHub did not report', async () => {
  // Absent permissions are GitHub's to omit. Refusing on an omission would
  // refuse to run for the very identities this check exists to support, so an
  // unreadable answer admits and leaves publication to report a real refusal.
  const { exitCode } = await verify({ body: JSON.stringify({ id: 1 }) });

  assert.equal(exitCode, 0);
});
