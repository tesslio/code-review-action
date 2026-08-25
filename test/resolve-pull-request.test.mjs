import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = new URL('../src/resolve-pull-request.mjs', import.meta.url)
  .pathname;
const stub = new URL('./stub-configured-github-fetch.mjs', import.meta.url)
  .pathname;

const HEAD_SHA = 'a'.repeat(40);

function pullRequest(user) {
  return JSON.stringify({
    state: 'open',
    user,
    head: { sha: HEAD_SHA, repo: { full_name: 'acme/widgets' } },
  });
}

async function resolve(user) {
  const directory = await mkdtemp(join(tmpdir(), 'code-review-action-test-'));
  const outputs = join(directory, 'outputs');
  await writeFile(outputs, '');

  try {
    await run(process.execPath, ['--import', stub, script], {
      env: {
        PATH: process.env.PATH,
        GH_TOKEN: 'token',
        REPOSITORY: 'acme/widgets',
        EVENT_NAME: 'issue_comment',
        EVENT_PR_NUMBER: '42',
        GITHUB_OUTPUT: outputs,
        RESPONSE_BODY: pullRequest(user),
      },
    });
    return Object.fromEntries(
      (await readFile(outputs, 'utf8'))
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('infers the pull request author as an approver when it is an App', async () => {
  const outputs = await resolve({ login: 'kikimora-dev[bot]', type: 'Bot' });

  assert.equal(outputs['inferred-approver'], 'kikimora-dev[bot]');
  assert.equal(outputs['head-sha'], HEAD_SHA);
});

test('infers no approver from a human author', async () => {
  // A person asking for approval on their own pull request is the loop a
  // required review exists to prevent, so inference stops at an App.
  const outputs = await resolve({ login: 'octocat', type: 'User' });

  assert.equal(outputs['inferred-approver'], '');
});

test('infers no approver when the payload names no author', async () => {
  const outputs = await resolve(undefined);

  assert.equal(outputs['inferred-approver'], '');
});
