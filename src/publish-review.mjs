#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';

import { requiredEnv, requiredPositiveIntegerEnv } from './env.mjs';
import { GitHubCodeReviewApi } from './github-api.mjs';
import { publishCodeReview } from './publisher.mjs';
import { ResultFileError, readReviewResult } from './result-file.mjs';

const api = new GitHubCodeReviewApi({
  token: requiredEnv('GH_TOKEN'),
  repository: requiredEnv('REPOSITORY'),
});
// An unreadable result is a failure of the review result, not of publication.
// Annotating it says which one it is, where a bare parser stack would not.
let result;
try {
  result = await readReviewResult(requiredEnv('REVIEW_OUTPUT'));
} catch (error) {
  if (error instanceof ResultFileError) console.log(`::error::${error.message}`);
  throw error;
}
const mode = requiredEnv('MODE');
if (mode !== 'advisory' && mode !== 'gate') {
  throw new Error('MODE must be advisory or gate.');
}
if (result.status !== 'ok' || !result.outcome) {
  throw new Error('The Code Review result does not contain a publishable outcome.');
}
const reviewEvent =
  mode === 'advisory'
    ? 'COMMENT'
    : result.outcome.approved === true
      ? 'APPROVE'
      : 'REQUEST_CHANGES';
const published = await publishCodeReview({
  api,
  prNumber: requiredPositiveIntegerEnv('PR_NUMBER'),
  expectedHeadSha: requiredEnv('HEAD_SHA'),
  attemptId: requiredEnv('GITHUB_RUN_ID'),
  result,
  reviewEvent,
  mode,
});

if (process.env.PUBLISH_OUTPUT) {
  await writeFile(
    process.env.PUBLISH_OUTPUT,
    `${JSON.stringify(published, null, 2)}\n`,
    'utf8',
  );
}

if (process.env.GITHUB_OUTPUT) {
  const reviewId = published.reviewId ?? '';
  await writeFile(
    process.env.GITHUB_OUTPUT,
    `review-id=${reviewId}\npublication-status=${published.status}\n`,
    { encoding: 'utf8', flag: 'a' },
  );
}

console.log(JSON.stringify(published));
