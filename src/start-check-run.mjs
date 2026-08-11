#!/usr/bin/env node

import { appendFile } from 'node:fs/promises';

import { concludeReviewCheckRun, startReviewCheckRun } from './check-run.mjs';
import { requiredEnv } from './env.mjs';
import { GitHubCodeReviewApi } from './github-api.mjs';

const mode = requiredEnv('MODE');
const detailsUrl = requiredEnv('RUN_URL');

const api = new GitHubCodeReviewApi({
  token: requiredEnv('GH_TOKEN'),
  repository: requiredEnv('REPOSITORY'),
});
const checkRunId = await startReviewCheckRun({
  api,
  headSha: requiredEnv('HEAD_SHA'),
  detailsUrl,
});

try {
  await appendFile(
    requiredEnv('GITHUB_OUTPUT'),
    `check-run-id=${checkRunId ?? ''}\n`,
    'utf8',
  );
} catch (error) {
  // No later step can address a check run whose identifier was never handed
  // on, so conclude it here rather than leave it in progress forever.
  if (checkRunId !== undefined) {
    await concludeReviewCheckRun({
      api,
      checkRunId,
      mode,
      status: 'technical-failure',
      detailsUrl,
    });
  }
  throw error;
}
