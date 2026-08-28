/**
 * The visible notice a maintainer gets when a review does not complete.
 *
 * This is the one thing published from the Action rather than by the CLI, and
 * it has to be: it exists precisely for the runs where the CLI died, or never
 * started, and so published nothing itself.
 *
 * A run that stopped on its own configuration did leave a reason behind, and
 * the notice carries it: this is the surface a maintainer sees without leaving
 * the pull request, and without it every failure reads the same. Which reasons
 * may be quoted is decided in `failure-reason.mjs`; anything else keeps the
 * bare sentence and the link.
 *
 * The marker is what makes the notice replaceable rather than repeated — a
 * later run updates the existing notice, and a run that finally succeeds
 * removes it.
 */

export const FAILURE_MARKER = '<!-- tessl-code-review:failure:v1 -->';

const NOTICE_AUTHOR = 'github-actions[bot]';

function ownNotices(comments) {
  return comments.filter(
    (comment) =>
      comment.user?.login === NOTICE_AUTHOR &&
      String(comment.body ?? '').includes(FAILURE_MARKER),
  );
}

export async function publishFailureNotice({ api, prNumber, runUrl, reason }) {
  const explanation = reason
    ? `\n\nThe Tessl CLI reported: \`${reason}\``
    : '';
  const body = `${FAILURE_MARKER}\nTessl Code Review did not complete. [View the workflow run](${runUrl}).${explanation}`;
  const comments = await api.issueComments(prNumber);
  const existing = ownNotices(comments)[0];
  if (existing) {
    await api.updateIssueComment(existing.id, body);
    return { status: 'updated', commentId: existing.id };
  }
  const created = await api.createIssueComment(prNumber, body);
  return { status: 'created', commentId: created.id };
}

/** Clear notices left by earlier runs once a review has completed. */
export async function removeFailureNotices({ api, prNumber }) {
  const stale = ownNotices(await api.issueComments(prNumber));
  for (const comment of stale) await api.deleteIssueComment(comment.id);
  return stale.length;
}
