#!/usr/bin/env node

import { requiredEnv, requiredPositiveIntegerEnv } from './env.mjs';
import { GitHubCodeReviewApi } from './github-api.mjs';
import { publishFailureNotice } from './failure-notice.mjs';

const api = new GitHubCodeReviewApi({
  token: requiredEnv('GH_TOKEN'),
  repository: requiredEnv('REPOSITORY'),
});
const published = await publishFailureNotice({
  api,
  prNumber: requiredPositiveIntegerEnv('PR_NUMBER'),
  runUrl: requiredEnv('RUN_URL'),
});

console.log(JSON.stringify(published));
