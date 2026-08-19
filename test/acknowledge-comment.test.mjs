import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = new URL('../src/acknowledge-comment.mjs', import.meta.url)
  .pathname;
const stub = new URL('./stub-github-fetch.mjs', import.meta.url).pathname;

async function acknowledge(env = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'code-review-action-test-'));
  const requests = join(directory, 'requests');
  await writeFile(requests, '');

  try {
    const completed = await run(process.execPath, ['--import', stub, script], {
      env: {
        PATH: process.env.PATH,
        GH_TOKEN: 'token',
        REPOSITORY: 'acme/widgets',
        EVENT_NAME: 'issue_comment',
        COMMENT_ID: '4242',
        REQUEST_LOG: requests,
        ...env,
      },
    }).catch((error) => error);
    return {
      exitCode: completed.code ?? 0,
      stdout: completed.stdout ?? '',
      requests: (await readFile(requests, 'utf8')).trim(),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('reacts on the conversation endpoint for an issue comment', async () => {
  const { exitCode, requests } = await acknowledge();

  assert.equal(exitCode, 0);
  assert.equal(
    requests,
    'POST https://api.github.com/repos/acme/widgets/issues/comments/4242/reactions {"content":"eyes"}',
  );
});

test('reacts on the review endpoint for an inline review comment', async () => {
  const { exitCode, requests } = await acknowledge({
    EVENT_NAME: 'pull_request_review_comment',
    COMMENT_ID: '77',
  });

  assert.equal(exitCode, 0);
  assert.match(requests, /\/pulls\/comments\/77\/reactions/);
});

test('reacts to nothing on an event that carries no comment', async () => {
  for (const eventName of ['pull_request', 'workflow_dispatch']) {
    const { exitCode, requests } = await acknowledge({
      EVENT_NAME: eventName,
      COMMENT_ID: '',
    });

    assert.equal(exitCode, 0);
    assert.equal(requests, '');
  }
});

test('names the event payload when the comment id is unusable', async () => {
  const { exitCode, stdout, requests } = await acknowledge({
    COMMENT_ID: 'not-an-id',
  });

  assert.equal(exitCode, 0);
  assert.equal(requests, '');
  assert.match(stdout, /no usable comment id \(not-an-id\)/);
});

test('names the step wiring when the token or repository is absent', async () => {
  for (const absent of [{ GH_TOKEN: '' }, { REPOSITORY: '' }]) {
    const { exitCode, stdout, requests } = await acknowledge(absent);

    assert.equal(exitCode, 0);
    assert.equal(requests, '');
    assert.match(stdout, /no GitHub token or repository was supplied/);
  }
});

test('says so and continues when GitHub refuses the reaction', async () => {
  const refusing = new URL('./stub-refusing-github-fetch.mjs', import.meta.url)
    .pathname;
  const completed = await run(process.execPath, ['--import', refusing, script], {
    env: {
      PATH: process.env.PATH,
      GH_TOKEN: 'token',
      REPOSITORY: 'acme/widgets',
      EVENT_NAME: 'issue_comment',
      COMMENT_ID: '4242',
    },
  }).catch((error) => error);

  assert.equal(completed.code ?? 0, 0);
  assert.match(completed.stdout ?? '', /::notice::Could not acknowledge/);
});
