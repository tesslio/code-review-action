import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The wiring, exercised by running `finalize.mjs` as the Action runs it.
 *
 * Every other test in this file's neighbourhood imports the renderer directly,
 * which proves the Markdown is right and proves nothing about whether the step
 * ever reaches it. This runs the real script with the real environment contract
 * — a result file on disk, `GITHUB_STEP_SUMMARY` and `GITHUB_OUTPUT` pointing at
 * real files — and reads back what it wrote.
 *
 * No check-run id and no pull-request number are supplied, so the script makes
 * no GitHub API call: the only side effects are the two files.
 */
async function runFinalize({ result, mode = 'advisory', exitCode = '0', headSha }) {
  const directory = await mkdtemp(join(tmpdir(), 'tessl-finalize-'));
  const resultPath = join(directory, 'result.json');
  const summaryPath = join(directory, 'summary.md');
  const outputPath = join(directory, 'output.txt');
  await writeFile(resultPath, JSON.stringify(result), 'utf8');
  await writeFile(summaryPath, '', 'utf8');
  await writeFile(outputPath, '', 'utf8');

  const finalize = new URL('../src/finalize.mjs', import.meta.url).pathname;
  // A non-zero exit is a real outcome here — a publication failure exits 1 — so
  // the exit code is captured rather than thrown, and the files are read either
  // way. Throwing would hide exactly the case this test exists for.
  const invocation = run(process.execPath, [finalize], {
    env: {
      ...process.env,
      MODE: mode,
      REVIEW_EXIT_CODE: exitCode,
      REVIEW_OUTPUT: resultPath,
      GITHUB_STEP_SUMMARY: summaryPath,
      GITHUB_OUTPUT: outputPath,
      RUN_URL: 'https://github.example/run/7',
      REPOSITORY: 'tesslio/code-review-action',
      ...(headSha === undefined ? {} : { HEAD_SHA: headSha }),
      CHECK_RUN_ID: '',
      PR_NUMBER: '',
    },
  }).catch((error) => ({ stdout: error.stdout ?? '', code: error.code ?? 1 }));
  const { stdout, code = 0 } = await invocation;

  return {
    summary: await readFile(summaryPath, 'utf8'),
    output: await readFile(outputPath, 'utf8'),
    stdout,
    code,
  };
}

const HEAD = '714940a07292da93003f8696604a28ababd844bb';

const reviewedResult = {
  status: 'ok',
  outcome: {
    approved: false,
    judgement: 'Two rough edges worth fixing before this lands.',
    lenses: [{ ref: 'tessl/code-review@0.1.0#review-security-and-privacy' }],
    subject: { change: { headRevision: HEAD } },
    findings: [
      {
        severity: 'critical',
        title: 'A blocking finding',
        requiresChanges: true,
        path: 'src/thing.mjs',
        line: 12,
      },
      {
        severity: 'minor',
        title: 'A suggestion',
        requiresChanges: false,
        path: 'src/other.mjs',
        line: 3,
      },
    ],
  },
  diagnostics: { durationMs: 61_000 },
  publication: { status: 'published', reviewId: 42, inlineCount: 2 },
};

test('finalize writes the review to the job summary it is given', async () => {
  const { summary, output } = await runFinalize({
    result: reviewedResult,
    headSha: HEAD,
  });

  assert.match(summary, /^## Tessl Code Review$/mu);
  assert.match(summary, /^### Changes requested \(1\)$/mu);
  assert.match(summary, /A blocking finding/u);
  assert.match(summary, /`src\/thing\.mjs:12`/u);
  assert.match(summary, /^#### Findings$/mu);
  // The step's own contract is unaffected by the summary write.
  assert.match(output, /^status=advisory-findings$/mu);
});

test('finalize writes the review even when the run failed to publish it', async () => {
  const { summary, output, code } = await runFinalize({
    result: reviewedResult,
    exitCode: '1',
    headSha: HEAD,
  });

  // The review is still readable, and the status is quoted beneath it.
  assert.match(summary, /^### Changes requested \(1\)$/mu);
  assert.match(summary, /> Tessl Code Review completed but could not publish/u);
  assert.match(output, /^status=publication-failure$/mu);
  assert.equal(code, 1, 'a publication failure fails the step');
});

test('finalize writes the status when the CLI produced no result at all', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tessl-finalize-'));
  const summaryPath = join(directory, 'summary.md');
  const outputPath = join(directory, 'output.txt');
  await writeFile(summaryPath, '', 'utf8');
  await writeFile(outputPath, '', 'utf8');
  const finalize = new URL('../src/finalize.mjs', import.meta.url).pathname;

  await assert.rejects(
    run(process.execPath, [finalize], {
      env: {
        ...process.env,
        MODE: 'gate',
        REVIEW_EXIT_CODE: '1',
        REVIEW_OUTPUT: join(directory, 'missing.json'),
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_OUTPUT: outputPath,
        RUN_URL: 'https://github.example/run/7',
        REPOSITORY: 'tesslio/code-review-action',
        CHECK_RUN_ID: '',
        PR_NUMBER: '',
      },
    }),
  );

  const summary = await readFile(summaryPath, 'utf8');
  assert.match(summary, /^### Review did not complete$/mu);
  assert.doesNotMatch(summary, /#### Findings/u);
});

test('a missing GITHUB_STEP_SUMMARY is not an error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tessl-finalize-'));
  const resultPath = join(directory, 'result.json');
  const outputPath = join(directory, 'output.txt');
  await writeFile(resultPath, JSON.stringify(reviewedResult), 'utf8');
  await writeFile(outputPath, '', 'utf8');
  const finalize = new URL('../src/finalize.mjs', import.meta.url).pathname;

  const { stdout } = await run(process.execPath, [finalize], {
    env: {
      ...process.env,
      MODE: 'advisory',
      REVIEW_EXIT_CODE: '0',
      REVIEW_OUTPUT: resultPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: '',
      RUN_URL: 'https://github.example/run/7',
      REPOSITORY: 'tesslio/code-review-action',
      HEAD_SHA: HEAD,
      CHECK_RUN_ID: '',
      PR_NUMBER: '',
    },
  });

  assert.doesNotMatch(stdout, /::notice::/u);
  assert.match(await readFile(outputPath, 'utf8'), /^status=advisory-findings$/mu);
});
