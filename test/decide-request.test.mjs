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
    'ran `bun test`, all green @tessl-code-review',
    // Not a fence opener: a backtick fence's info string may not contain a
    // backtick, so the request below it is not swallowed.
    '```js `x`\n@tessl-code-review',
    '> an earlier remark\n\n@tessl-code-review',
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

test('a comment showing or quoting the handle requests nothing', async () => {
  for (const body of [
    '`@tessl-code-review`',
    'I am not going to fire another `@tessl-code-review` round',
    'ask for one with ``@tessl-code-review``',
    'trigger it with:\n\n```\n@tessl-code-review\n```\n',
    '~~~\n@tessl-code-review\n~~~',
    // A closing fence is at least as long as the one that opened the block, so
    // the shorter run inside leaves the handle in code.
    '````\n```\n@tessl-code-review\n```\n````',
    // A span closes on a run of its own length, and may cross lines.
    'the handle is `foo\n@tessl-code-review` there',
    '> @tessl-code-review',
    '> please @tessl-code-review look again',
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

test("the pull request's own author is never refused by the allowlist", async () => {
  // GitHub reports the same person differently by event: a review comment on a
  // branch they authored comes through as CONTRIBUTOR, where a conversation
  // comment on the same pull request is MEMBER. An allowlist without CONTRIBUTOR
  // therefore refused an author's own inline request until this case existed.
  const { exitCode, outputs } = await decide({
    EVENT_NAME: 'pull_request_review_comment',
    COMMENT_BODY: '@tessl-code-review',
    COMMENT_ASSOCIATION: 'CONTRIBUTOR',
    COMMENT_AUTHOR: 'author',
    PR_AUTHOR: 'author',
    ALLOWED_ASSOCIATIONS: 'OWNER,MEMBER,COLLABORATOR',
  });

  assert.equal(exitCode, 0);
  assert.match(outputs, /requested=true/);
});

test('someone else with an unaccepted association is still refused', async () => {
  const { outputs, stdout } = await decide({
    EVENT_NAME: 'pull_request_review_comment',
    COMMENT_BODY: '@tessl-code-review',
    COMMENT_ASSOCIATION: 'CONTRIBUTOR',
    COMMENT_AUTHOR: 'someone-else',
    PR_AUTHOR: 'author',
    ALLOWED_ASSOCIATIONS: 'OWNER,MEMBER,COLLABORATOR',
  });

  assert.match(outputs, /requested=false/);
  assert.match(stdout, /association is not one this caller accepts/);
});

test('an author exemption needs a real login on both sides', async () => {
  // An absent author must not match an absent pull-request author and admit
  // everything: two empty values are not the same person.
  const { outputs } = await decide({
    EVENT_NAME: 'issue_comment',
    COMMENT_BODY: '@tessl-code-review',
    COMMENT_ASSOCIATION: 'NONE',
    COMMENT_AUTHOR: '',
    PR_AUTHOR: '',
    ALLOWED_ASSOCIATIONS: 'OWNER',
  });

  assert.match(outputs, /requested=false/);
});

test('the author exemption ignores login casing', async () => {
  const { outputs } = await decide({
    EVENT_NAME: 'pull_request_review_comment',
    COMMENT_BODY: '@tessl-code-review',
    COMMENT_ASSOCIATION: 'CONTRIBUTOR',
    COMMENT_AUTHOR: 'Author',
    PR_AUTHOR: 'author',
    ALLOWED_ASSOCIATIONS: 'OWNER,MEMBER,COLLABORATOR',
  });

  assert.match(outputs, /requested=true/);
});

test('a named approver is admitted past an association allowlist', async () => {
  // A GitHub App comments as NONE whatever its permissions, so an allowlist of
  // human associations refuses the very App the caller named as an approver —
  // and refuses it as "no review requested", so it gets neither the approval it
  // asked for nor the refusal saying why not.
  const { outputs } = await decide({
    COMMENT_BODY: '@tessl-code-review approve',
    COMMENT_ASSOCIATION: 'NONE',
    COMMENT_AUTHOR: 'kikimora-dev[bot]',
    ALLOWED_ASSOCIATIONS: 'OWNER,MEMBER,COLLABORATOR',
    APPROVER_LOGINS: 'kikimora-dev[bot]',
  });
  assert.match(outputs, /requested=true/);
});

test('an approver list read either way admits the same logins', async () => {
  for (const APPROVER_LOGINS of [
    'other[bot],kikimora-dev[bot]',
    'other[bot]\nkikimora-dev[bot]',
    ' Kikimora-Dev[Bot] , other[bot] ',
  ]) {
    const { outputs } = await decide({
      COMMENT_BODY: '@tessl-code-review approve',
      COMMENT_ASSOCIATION: 'NONE',
      COMMENT_AUTHOR: 'kikimora-dev[bot]',
      ALLOWED_ASSOCIATIONS: 'OWNER',
      APPROVER_LOGINS,
    });
    assert.match(outputs, /requested=true/, APPROVER_LOGINS);
  }
});

test('an approver list admits nobody it does not name', async () => {
  const { outputs } = await decide({
    COMMENT_BODY: '@tessl-code-review approve',
    COMMENT_ASSOCIATION: 'NONE',
    COMMENT_AUTHOR: 'other-app[bot]',
    ALLOWED_ASSOCIATIONS: 'OWNER,MEMBER,COLLABORATOR',
    APPROVER_LOGINS: 'kikimora-dev[bot]',
  });
  assert.match(outputs, /requested=false/);
});
