/**
 * The answer a commenter gets when they asked for an approval they may not give.
 *
 * Published from the Action rather than by the CLI for the same reason the
 * failure notice is: there is no review to carry it. The run deliberately made
 * none, so the only thing that reaches the pull request is this.
 *
 * The marker carries the triggering comment's id, so the notice is one answer
 * per question. Rerunning the same job updates the answer already there instead
 * of repeating it, and a second comment asking again is a second question and
 * gets its own.
 */

export const APPROVAL_REFUSAL_MARKER_PREFIX =
  '<!-- tessl-code-review:approval-refused:v1';

const NOTICE_AUTHOR = 'github-actions[bot]';

/** The marker identifying the answer to one triggering comment. */
export function approvalRefusalMarker(commentId) {
  return `${APPROVAL_REFUSAL_MARKER_PREFIX} id=${commentId} -->`;
}

/**
 * The notice body. It says what was refused, who may ask, and — the part a
 * reader cannot work out from being told no — that a review is still available
 * for the asking.
 */
export function approvalRefusalBody(commentId) {
  return [
    approvalRefusalMarker(commentId),
    'Tessl Code Review was asked to approve this pull request, and the author of that comment is not permitted to approve. No review was run, because approving is not a review: running one would answer a question nobody asked.',
    '',
    'Comment `@tessl-code-review` to have the change reviewed. Approving from a comment is limited to the repository members GitHub already knows, and to the comment authors the workflow names in `approver-logins`.',
  ].join('\n');
}

export async function publishApprovalRefusalNotice({
  api,
  prNumber,
  commentId,
}) {
  const marker = approvalRefusalMarker(commentId);
  const body = approvalRefusalBody(commentId);
  const comments = await api.issueComments(prNumber);
  const existing = comments.find(
    (comment) =>
      comment.user?.login === NOTICE_AUTHOR &&
      String(comment.body ?? '').includes(marker),
  );
  if (existing) {
    await api.updateIssueComment(existing.id, body);
    return { status: 'updated', commentId: existing.id };
  }
  const created = await api.createIssueComment(prNumber, body);
  return { status: 'created', commentId: created.id };
}
