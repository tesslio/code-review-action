import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = new URL('../src/decide-request.mjs', import.meta.url).pathname;

async function decide(env = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'code-review-action-test-'));
  const outputs = join(directory, 'outputs');
  await writeFile(outputs, '');

  try {
    const completed = await run(process.execPath, [script], {
      env: {
        PATH: process.env.PATH,
        EVENT_NAME: 'issue_comment',
        GITHUB_OUTPUT: outputs,
        ...env,
      },
    }).catch((error) => error);
    return {
      exitCode: completed.code ?? 0,
      stdout: completed.stdout ?? '',
      stderr: completed.stderr ?? '',
      outputs: await readFile(outputs, 'utf8'),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a comment naming the handle as a whole token requests a review', async () => {
  for (const body of [
    '@tessl-code-review',
    'please @tessl-code-review have another look',
    'fixes pushed\n@tessl-code-review',
    '@tessl-code-review, thanks',
    'ping @Tessl-Code-Review',
    '`@tessl-code-review`',
  ]) {
    const { exitCode, outputs } = await decide({ COMMENT_BODY: body });

    assert.equal(exitCode, 0, body);
    assert.match(outputs, /requested=true/, body);
  }
});

test('a comment naming a longer handle requests nothing', async () => {
  for (const body of [
    '@tessl-code-reviewer take a look',
    '@tessl-code-review-bot take a look',
    'x@tessl-code-review',
  ]) {
    const { exitCode, outputs, stdout } = await decide({ COMMENT_BODY: body });

    assert.equal(exitCode, 0, body);
    assert.match(outputs, /requested=false/, body);
    assert.match(outputs, /status=not-requested/, body);
    assert.match(stdout, /::notice::No review requested/, body);
  }
});

test('a comment that never mentions the handle requests nothing', async () => {
  const { outputs } = await decide({ COMMENT_BODY: 'looks good to me' });

  assert.match(outputs, /requested=false/);
});

test('an event that is not a comment always requests a review', async () => {
  for (const eventName of ['pull_request', 'workflow_dispatch']) {
    const { outputs } = await decide({ EVENT_NAME: eventName });

    assert.match(outputs, /requested=true/);
    assert.match(outputs, /status=\n/);
  }
});

test('an accepted association requests a review, and any other does not', async () => {
  const body = '@tessl-code-review';

  const accepted = await decide({
    COMMENT_BODY: body,
    COMMENT_ASSOCIATION: 'member',
    ALLOWED_ASSOCIATIONS: 'OWNER, MEMBER ,COLLABORATOR',
  });
  assert.match(accepted.outputs, /requested=true/);

  const refused = await decide({
    COMMENT_BODY: body,
    COMMENT_ASSOCIATION: 'NONE',
    ALLOWED_ASSOCIATIONS: 'OWNER,MEMBER,COLLABORATOR',
  });
  assert.match(refused.outputs, /requested=false/);
  assert.match(refused.stdout, /association is not one this caller accepts/);
});

test('an empty allowlist accepts any author', async () => {
  const { outputs } = await decide({
    COMMENT_BODY: '@tessl-code-review',
    COMMENT_ASSOCIATION: 'NONE',
    ALLOWED_ASSOCIATIONS: '   ',
  });

  assert.match(outputs, /requested=true/);
});

test('an allowlist naming something GitHub does not fails loudly', async () => {
  const { exitCode, stderr } = await decide({
    COMMENT_BODY: '@tessl-code-review',
    ALLOWED_ASSOCIATIONS: 'OWNER,MAINTAINER',
  });

  assert.notEqual(exitCode, 0);
  assert.match(stderr, /allowed-associations must name GitHub author associations/);
  assert.match(stderr, /MAINTAINER/);
});
