import {
  KNOWN_RECEIPT_STATUSES,
  PUBLISHED_STATUSES,
  isNoMatchingLensesResult,
} from './result-file.mjs';

/** Whether the run reached a terminal state that published or deliberately did not. */
export function isCompletedPublication(publication) {
  return (
    PUBLISHED_STATUSES.has(publication?.status) ||
    publication?.status === 'published-with-policy-fallback'
  );
}

/**
 * Map a completed run onto the terminal status the check run reports and the
 * exit code the job takes.
 *
 * The CLI both reviews and publishes, and reports one exit code for the pair.
 * So a non-zero exit alone cannot say which failed, and the two are not
 * equivalent: a review that never produced an outcome is a technical failure,
 * while a review that completed and could not be published is a publication
 * failure the author can often fix. The result document is what separates them
 * — it carries the outcome when the review succeeded, and the receipt when
 * publication did.
 */
export function reviewConclusion({ mode, reviewExitCode, result, headSha }) {
  if (mode !== 'advisory' && mode !== 'gate') {
    throw new Error('mode must be advisory or gate.');
  }

  const reviewSucceeded = reviewExitCode === '0';

  // Checked before anything the result claims: a record written by a run that
  // then failed describes an invocation that did not finish, and reading it as
  // a terminal success would conclude the check run green and clear the notice
  // saying otherwise.
  if (!reviewSucceeded) {
    return result?.status === 'ok' && result?.outcome !== undefined
      ? { status: 'publication-failure', exitCode: 1 }
      : { status: 'technical-failure', exitCode: 1 };
  }

  if (isNoMatchingLensesResult(result)) {
    return { status: 'skipped-no-matching-lenses', exitCode: 0 };
  }

  // The check run is attached to the head this Action resolved and checked out,
  // so it can only be concluded by a verdict that identifies that exact
  // revision. A different one is a head the CLI resolved for itself and is not
  // the one under check; an absent one establishes nothing at all, and passing
  // a gate on it would assert a verdict for a commit nothing named. Both fail
  // closed, so equality with the resolved head is the only way through.
  const reviewedHead = result?.outcome?.subject?.change?.headRevision;
  if (headSha !== undefined && reviewedHead !== headSha) {
    return { status: 'superseded', exitCode: 1 };
  }

  // Only a boolean verdict decides a gate. An absent one establishes nothing
  // about the reviewed head, so gate mode fails closed rather than passing it.
  const approved = result?.outcome?.approved;
  if (mode === 'gate' && typeof approved !== 'boolean') {
    return { status: 'gate-verdict-failure', exitCode: 1 };
  }

  const publication = result?.publication;
  if (!KNOWN_RECEIPT_STATUSES.has(publication?.status)) {
    return { status: 'publication-failure', exitCode: 1 };
  }
  if (publication.status === 'superseded') {
    return { status: 'superseded', exitCode: 1 };
  }
  if (publication.status === 'published-with-policy-fallback') {
    return { status: 'gate-configuration-failure', exitCode: 1 };
  }
  if (mode === 'gate' && approved === false) {
    return { status: 'changes-requested', exitCode: 1 };
  }
  return {
    status: approved === true ? 'approved' : 'advisory-findings',
    exitCode: 0,
  };
}
