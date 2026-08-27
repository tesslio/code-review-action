#!/usr/bin/env node

/**
 * Fail early when the token that will author the review cannot reach the
 * repository at all.
 *
 * The review is published by the CLI, at the end of a job that has already
 * created a check run, checked out the head and installed the CLI. A token that
 * is invalid, expired, or attached to an App nobody installed is therefore
 * discovered several minutes in, and reported as a publication failure rather
 * than as the configuration mistake it is. One request up front turns that into
 * a message naming the token.
 *
 * Reachability is the whole check, deliberately. GitHub exposes no pre-flight
 * answer to the question that actually matters — may this token write a review —
 * and the nearest available signal is wrong for it: `permissions.push` on a
 * repository describes content write, so a fine-grained token holding exactly
 * `contents: read` and `pull-requests: write`, the baseline this Action
 * requires, can report `push: false`. Gating on it would refuse
 * the recommended configuration outright, while still admitting a token with
 * content write and no pull-request access. Authorization is left to the review
 * endpoint, which answers it exactly.
 */

import { requiredEnv } from './env.mjs';
import { GitHubApiError, GitHubCodeReviewApi } from './github-api.mjs';

const repository = requiredEnv('REPOSITORY');
const api = new GitHubCodeReviewApi({
  token: requiredEnv('GH_TOKEN'),
  repository,
});

try {
  await api.request(`/repos/${repository}`);
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

console.log(`::notice::The reviewing identity can reach ${repository}.`);
