#!/usr/bin/env node

import { appendFile } from 'node:fs/promises';

import { requiredEnv } from './env.mjs';
import { GitHubCodeReviewApi } from './github-api.mjs';

const repository = requiredEnv('REPOSITORY');
const eventName = requiredEnv('EVENT_NAME');
const requestedNumber =
  eventName === 'workflow_dispatch'
    ? process.env.INPUT_PR_NUMBER
    : process.env.EVENT_PR_NUMBER || process.env.INPUT_PR_NUMBER;

if (!/^[1-9]\d*$/.test(requestedNumber ?? '')) {
  throw new Error('Pull-request number must be a positive integer.');
}

const number = Number(requestedNumber);
const api = new GitHubCodeReviewApi({
  token: requiredEnv('GH_TOKEN'),
  repository,
});
const pullRequest = await api.pullRequest(number);

if (pullRequest.state !== 'open') {
  throw new Error(`Pull request ${number} is not open.`);
}

const headRepository = pullRequest.head?.repo?.full_name;
if (headRepository !== repository) {
  throw new Error('Cross-repository pull requests are not supported.');
}

const eventHead = process.env.EVENT_HEAD_SHA;
const headSha = eventName === 'pull_request' && eventHead
  ? eventHead
  : pullRequest.head?.sha;
if (!/^[0-9a-f]{40}$/i.test(headSha ?? '')) {
  throw new Error('GitHub returned an invalid pull-request head SHA.');
}

const output = requiredEnv('GITHUB_OUTPUT');
await appendFile(
  output,
  [
    `number=${number}`,
    `head-sha=${headSha}`,
    `head-repository=${headRepository}`,
    '',
  ].join('\n'),
  'utf8',
);
