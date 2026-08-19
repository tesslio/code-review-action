#!/usr/bin/env node

/**
 * React 👀 to the comment that asked for this review.
 *
 * Runs first, ahead of pull-request resolution and the check run, because the
 * check run is what makes a review visible: a reaction posted after it tells
 * the reader nothing they cannot already see. Reacting here takes seconds from
 * the comment being written.
 *
 * Nothing this script does is worth failing a review over, so every failure
 * becomes a notice and the exit status stays zero.
 */

import { GitHubCodeReviewApi } from './github-api.mjs';

const KINDS = new Map([
  ['issue_comment', 'issue-comment'],
  ['pull_request_review_comment', 'review-comment'],
]);

const kind = KINDS.get(process.env.EVENT_NAME ?? '');
const commentId = process.env.COMMENT_ID ?? '';
const token = process.env.GH_TOKEN ?? '';
const repository = process.env.REPOSITORY ?? '';

if (kind === undefined) {
  // A pull_request or workflow_dispatch run has no comment to answer.
  process.exit(0);
}

// Separate notices: a missing token or repository is the workflow's wiring,
// while an unusable id is the event's payload, and they send a reader looking
// in different places.
if (token === '' || repository === '') {
  console.log(
    '::notice::Skipped acknowledging the triggering comment: no GitHub token or repository was supplied to this step.',
  );
  process.exit(0);
}

if (!/^[1-9]\d*$/.test(commentId)) {
  console.log(
    `::notice::Skipped acknowledging the triggering comment: the event carried no usable comment id (${commentId === '' ? 'empty' : commentId}).`,
  );
  process.exit(0);
}

try {
  await new GitHubCodeReviewApi({ token, repository }).addCommentReaction({
    kind,
    commentId,
    content: 'eyes',
  });
} catch (cause) {
  console.log(
    `::notice::Could not acknowledge the triggering comment: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
}
