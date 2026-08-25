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

/**
 * The pull request's own author, when that author is a GitHub App, added to
 * whatever logins the caller named as permitted to request an approval.
 *
 * An agent that opens a pull request, pushes fixes and then asks for approval
 * is otherwise admitted — the request gate already exempts a pull request's
 * author — and then silently downgraded to a review, because the login never
 * reached the approver list. A caller that forgets the input sees a reviewer
 * that reviews and never approves, with nothing saying why.
 *
 * Restricted to an App because widening it to every author would let a person
 * ask for approval on their own pull request, which is the loop a required
 * review exists to prevent. This adds to the caller's list and never replaces
 * it: an approval may well be requested by a bot other than the one that opened
 * the pull request, and naming those stays the caller's to do.
 */
const author = pullRequest.user;
const inferredApprover =
  author?.type === 'Bot' && typeof author.login === 'string'
    ? author.login
    : '';

const output = requiredEnv('GITHUB_OUTPUT');
await appendFile(
  output,
  [
    `number=${number}`,
    `head-sha=${headSha}`,
    `head-repository=${headRepository}`,
    `inferred-approver=${inferredApprover}`,
    '',
  ].join('\n'),
  'utf8',
);
