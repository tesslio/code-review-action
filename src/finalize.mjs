#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises';

import { checkRunReport, concludeReviewCheckRun } from './check-run.mjs';
import { reviewConclusion } from './conclusion.mjs';
import { optionalPositiveIntegerEnv, requiredEnv } from './env.mjs';
import { GitHubCodeReviewApi } from './github-api.mjs';
import { ResultFileError, readReviewResult } from './result-file.mjs';

const mode = requiredEnv('MODE');

// An absent identifier means no check run was created, so there is nothing to
// conclude.
async function concludeCheckRun(status) {
  const checkRunId = optionalPositiveIntegerEnv('CHECK_RUN_ID');
  if (checkRunId === undefined) return;
  await concludeReviewCheckRun({
    api: new GitHubCodeReviewApi({
      token: requiredEnv('GH_TOKEN'),
      repository: requiredEnv('REPOSITORY'),
    }),
    checkRunId,
    mode,
    status,
    detailsUrl: requiredEnv('RUN_URL'),
  });
}

let conclusion;
try {
  const reviewSucceeded = process.env.REVIEW_EXIT_CODE === '0';
  const publishSucceeded = process.env.PUBLISH_EXIT_CODE === '0';
  const result = reviewSucceeded
    ? await readReviewResult(requiredEnv('REVIEW_OUTPUT'))
    : undefined;
  const publication = reviewSucceeded && publishSucceeded
    ? JSON.parse(await readFile(requiredEnv('PUBLISH_OUTPUT'), 'utf8'))
    : undefined;
  conclusion = reviewConclusion({
    mode,
    reviewExitCode: process.env.REVIEW_EXIT_CODE,
    publishExitCode: process.env.PUBLISH_EXIT_CODE,
    result,
    publication,
  });
} catch (error) {
  if (!(error instanceof ResultFileError)) {
    // A check run left in progress holds every pull request that requires it,
    // so conclude it before failing.
    await concludeCheckRun('technical-failure');
    throw error;
  }
  // The CLI exited successfully but left no usable result, so the review is
  // what failed. It is a terminal status like any other, and reporting it as
  // one keeps the status output and the check run in agreement. Nothing is
  // annotated here: the step that reads this file first has already named the
  // problem in the run, and it runs whenever this read does.
  conclusion = { status: 'technical-failure', exitCode: 1 };
}

// A superseded run fails the job while publishing no review, so the reason has
// to be visible in the run itself.
if (conclusion.status === 'superseded') {
  console.log(
    `::warning::${checkRunReport({ mode, status: conclusion.status }).summary}`,
  );
}

// The check run carries the computed status even when the step output cannot
// be written, and that write still fails the step afterwards.
try {
  await appendFile(
    requiredEnv('GITHUB_OUTPUT'),
    `status=${conclusion.status}\n`,
    'utf8',
  );
} finally {
  await concludeCheckRun(conclusion.status);
}

process.exitCode = conclusion.exitCode;
