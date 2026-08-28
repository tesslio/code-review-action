#!/usr/bin/env node

import { requiredEnv, requiredPositiveIntegerEnv } from './env.mjs';
import { configurationFailureReason } from './failure-reason.mjs';
import { GitHubCodeReviewApi } from './github-api.mjs';
import { publishFailureNotice } from './failure-notice.mjs';
import { readReviewResult } from './result-file.mjs';

/**
 * The reason to quote, or none.
 *
 * Every way of not having one is the same answer here: the step ran before the
 * CLI wrote a file, the file is unreadable or not JSON, or the failure is one
 * that is not surfaced. The notice is what tells a maintainer the run failed at
 * all, so a problem reading the result must not stop it being published.
 */
async function reasonToQuote() {
  const resultPath = process.env.REVIEW_OUTPUT;
  if (resultPath === undefined || resultPath === '') return undefined;
  try {
    return configurationFailureReason(await readReviewResult(resultPath));
  } catch {
    return undefined;
  }
}

const api = new GitHubCodeReviewApi({
  token: requiredEnv('GH_TOKEN'),
  repository: requiredEnv('REPOSITORY'),
});
const published = await publishFailureNotice({
  api,
  prNumber: requiredPositiveIntegerEnv('PR_NUMBER'),
  runUrl: requiredEnv('RUN_URL'),
  reason: await reasonToQuote(),
});

console.log(JSON.stringify(published));
