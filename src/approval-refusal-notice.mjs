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
 * The notice body: what happened, the rule that decided it, and the way to get
 * a review instead.
 *
 * It leads with the refusal because that is what the reader asked about, and
 * carries the absent review in the same line because that is the next thing
 * they would wonder. The rule is stated rather than the reader's standing under
 * it: both carry the same fact, and one of them reads as a verdict on the
 * person who asked.
 *
 * "Refused" is the word the terminal status uses, so a reader moving between
 * this comment, the check run and the workflow log meets one term rather than
 * three.
 */
export function approvalRefusalBody(commentId) {
  return [
    approvalRefusalMarker(commentId),
    'Approval request refused, and no review was run.',
    '',
    'Approving is limited to owners, members, and collaborators, plus any login the workflow names in `approver-logins`. Comment `@tessl-code-review` if you would like the change reviewed.',
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
