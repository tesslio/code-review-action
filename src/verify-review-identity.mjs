#!/usr/bin/env node

/**
 * Fail early when the token that will author the review cannot author one.
 *
 * The review is published by the CLI, at the end of a job that has already
 * created a check run, checked out the head and installed the CLI. A credential
 * that cannot write is therefore discovered several minutes in, and reported as
 * a publication failure rather than as the configuration mistake it is. One
 * request up front turns that into a message naming the token.
 *
 * What this deliberately does not check is whether the token may *approve*.
 * GitHub offers no way to ask ahead of time, and refusing to run on a guess
 * would replace a review that publishes findings as a comment — the CLI's own
 * fallback when an approval is refused — with no review at all.
 */

import { requiredEnv } from './env.mjs';
import { GitHubApiError, GitHubCodeReviewApi } from './github-api.mjs';

const repository = requiredEnv('REPOSITORY');
const api = new GitHubCodeReviewApi({
  token: requiredEnv('GH_TOKEN'),
  repository,
});

let repositoryData;
try {
  repositoryData = await api.request(`/repos/${repository}`);
} catch (error) {
  if (error instanceof GitHubApiError && error.status === 401) {
    throw new Error(
      `The github-token input was rejected by GitHub (401). It is invalid or has expired; a GitHub App installation token lasts one hour, so mint it in the same job that reviews.`,
    );
  }
  if (error instanceof GitHubApiError && error.status === 404) {
    throw new Error(
      `The github-token input cannot see ${repository} (404). A GitHub App must be installed on this repository, and a user token must have access to it.`,
    );
  }
  throw error;
}

/**
 * Absent permissions are not a refusal. The field is populated for the token
 * kinds seen so far, but it is GitHub's to omit, and treating an omission as a
 * failure would refuse to run for exactly the identities this input exists to
 * support. A present `push: false` is unambiguous and is refused.
 */
const permissions = repositoryData?.permissions;
if (permissions !== undefined && permissions !== null && !permissions.push) {
  throw new Error(
    `The github-token input has read-only access to ${repository}, so it cannot publish a review. Grant it pull-requests write and contents read.`,
  );
}

console.log(`::notice::Reviews will be published to ${repository}.`);
