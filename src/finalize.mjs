#!/usr/bin/env node

import { appendFile } from 'node:fs/promises';

import { checkRunReport, concludeReviewCheckRun } from './check-run.mjs';
import { isCompletedPublication, reviewConclusion } from './conclusion.mjs';
import { optionalPositiveIntegerEnv, requiredEnv } from './env.mjs';
import { removeFailureNotices } from './failure-notice.mjs';
import { GitHubCodeReviewApi } from './github-api.mjs';
import { ResultFileError, readReviewResult } from './result-file.mjs';

const mode = requiredEnv('MODE');

function githubApi() {
  return new GitHubCodeReviewApi({
    token: requiredEnv('GH_TOKEN'),
    repository: requiredEnv('REPOSITORY'),
  });
}

// An absent identifier means no check run was created, so there is nothing to
// conclude.
async function concludeCheckRun(status) {
  const checkRunId = optionalPositiveIntegerEnv('CHECK_RUN_ID');
  if (checkRunId === undefined) return;
  await concludeReviewCheckRun({
    api: githubApi(),
    checkRunId,
    mode,
    status,
    detailsUrl: requiredEnv('RUN_URL'),
  });
}

/**
 * Clear notices left by earlier failed runs once a run has completed.
 *
 * Completion, not approval: a gate that publishes requested changes exits
 * non-zero by design, and so does the policy fallback, but both reached the
 * pull request — a notice saying the review did not complete would be false.
 *
 * Best effort: the review is done either way, and a stale notice is worth a
 * warning rather than a failed job. This is the one piece of publication that
 * stays here, because the notice it clears is also published here.
 */
async function clearStaleFailureNotices() {
  const prNumber = optionalPositiveIntegerEnv('PR_NUMBER');
  if (prNumber === undefined) return;
  try {
    await removeFailureNotices({ api: githubApi(), prNumber });
  } catch (error) {
    console.log(
      `::notice::Stale failure notices could not be removed: ${error}. The review itself is unaffected.`,
    );
  }
}

let conclusion;
let reviewResult;
try {
  const result =
    process.env.REVIEW_EXIT_CODE === '0' ||
    process.env.REVIEW_OUTPUT !== undefined
      ? await readReviewResult(requiredEnv('REVIEW_OUTPUT'))
      : undefined;
  reviewResult = result;
  conclusion = reviewConclusion({
    mode,
    reviewExitCode: process.env.REVIEW_EXIT_CODE,
    result,
    headSha: process.env.HEAD_SHA,
  });
} catch (error) {
  if (!(error instanceof ResultFileError)) {
    // A check run left in progress holds every pull request that requires it,
    // so conclude it before failing.
    await concludeCheckRun('technical-failure');
    throw error;
  }
  // The CLI left no usable result, so the review is what failed. It is a
  // terminal status like any other, and reporting it as one keeps the status
  // output and the check run in agreement. Nothing is annotated here: the step
  // that reads this file first has already named the problem in the run.
  conclusion = { status: 'technical-failure', exitCode: 1 };
}

// A superseded run fails the job while publishing no review, so the reason has
// to be visible in the run itself.
if (conclusion.status === 'superseded') {
  console.log(
    `::warning::${checkRunReport({ mode, status: conclusion.status }).summary}`,
  );
}

if (
  conclusion.status === 'skipped-no-matching-lenses' ||
  isCompletedPublication(reviewResult?.publication)
) {
  await clearStaleFailureNotices();
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
