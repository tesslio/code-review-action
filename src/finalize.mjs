#!/usr/bin/env node

import { appendFile } from 'node:fs/promises';

import { checkRunReport, concludeReviewCheckRun } from './check-run.mjs';
import {
  COMPLETED_REVIEW_STATUSES,
  reviewConclusion,
} from './conclusion.mjs';
import { optionalPositiveIntegerEnv, requiredEnv } from './env.mjs';
import { publishApprovalRefusalNotice } from './approval-refusal-notice.mjs';
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
 * Keyed on the terminal status, which is the one value that already accounts
 * for every way a run can fail to complete: a non-zero CLI invocation, a
 * receipt that never reached a terminal state, and a verdict naming another
 * commit all conclude as something outside the completed set, while requested
 * changes and the policy fallback stay inside it despite concluding non-zero.
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

/**
 * Answer the comment that asked for an approval it may not have.
 *
 * The run made no review, so this notice is the only thing that reaches the
 * pull request: without it the commenter sees a neutral check and nothing that
 * says why. Best effort, like every other thing published from here — the
 * decision stands whether or not the comment lands, and a failed post is worth
 * a notice rather than a failed job.
 */
async function answerRefusedApprovalRequest() {
  const prNumber = optionalPositiveIntegerEnv('PR_NUMBER');
  const commentId = optionalPositiveIntegerEnv('COMMENT_ID');
  if (prNumber === undefined || commentId === undefined) return;
  try {
    await publishApprovalRefusalNotice({ api: githubApi(), prNumber, commentId });
  } catch (error) {
    console.log(
      `::notice::The refused approval request could not be answered on the pull request: ${error}. The review was still not run.`,
    );
  }
}

let conclusion;
try {
  // A step that never ran leaves its outputs empty rather than unset, so an
  // empty path is the review not having produced a result at all — which is a
  // technical failure to report, not a file to open.
  const resultPath = process.env.REVIEW_OUTPUT;
  const result =
    resultPath === undefined || resultPath === ''
      ? undefined
      : await readReviewResult(resultPath);
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

if (COMPLETED_REVIEW_STATUSES.has(conclusion.status)) {
  await clearStaleFailureNotices();
}

if (conclusion.status === 'refused-approval-request') {
  await answerRefusedApprovalRequest();
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
