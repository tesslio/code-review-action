import {
  KNOWN_RECEIPT_STATUSES,
  isApprovalNotPermittedResult,
  isNoMatchingLensesResult,
} from './result-file.mjs';

/**
 * The terminal statuses that mean a review completed for the head under check.
 *
 * Completion is not approval and it is not a receipt. A gate publishing
 * requested changes concludes the check a failure and completed; a run whose
 * CLI wrote a published receipt and then failed did not; and neither did one
 * whose verdict turned out to name a different commit. Naming the completed
 * states directly is what lets one condition cover all three, and they cannot
 * drift from the statuses above because they are the same values.
 *
 * `refused-approval-request` is deliberately absent even though its run
 * finished cleanly. This set clears the notice left by an earlier review that
 * did not complete, and a refusal establishes nothing about the commit that
 * notice describes: it answers a comment. Clearing on it would retract a
 * standing report of breakage that nothing has fixed. `skipped-no-matching-
 * lenses` stays, because that run did evaluate the change and found no lens
 * that applies to it.
 */
export const COMPLETED_REVIEW_STATUSES = new Set([
  'approved',
  'advisory-findings',
  'changes-requested',
  'gate-configuration-failure',
  'skipped-no-matching-lenses',
]);

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

  // Checked beside the no-match case and before anything that reads an outcome:
  // both are runs that reviewed nothing on purpose, so neither has a reviewed
  // head to identify or a verdict to gate on, and reading one as an incomplete
  // review would fail a run that did exactly what it should.
  if (isApprovalNotPermittedResult(result)) {
    return { status: 'refused-approval-request', exitCode: 0 };
  }

  // The check run is attached to the head this Action resolved and checked out,
  // so it can only be concluded by a verdict that identifies that exact
  // revision. A different one is a head the CLI resolved for itself and is not
  // the one under check; an absent one establishes nothing at all, and passing
  // a gate on it would assert a verdict for a commit nothing named. Both fail
  // closed, so equality with the resolved head is the only way through.
  const reviewedHead = result?.outcome?.subject?.change?.headRevision;
  if (headSha !== undefined && reviewedHead !== headSha) {
    // A CLI that publishes but never reports the revision it reviewed cannot
    // satisfy this, and saying "superseded" would send a maintainer looking for
    // a push that never happened. The caller chooses the CLI version, so the
    // incompatibility is theirs to fix and the status has to name it.
    return reviewedHead === undefined
      ? { status: 'incompatible-cli', exitCode: 1 }
      : { status: 'superseded', exitCode: 1 };
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
  // A gate that requests changes ran correctly and published a complete review,
  // and the check run carries that verdict, so the job succeeds. Exiting
  // non-zero would leave a caller unable to tell this outcome from a run that
  // produced no review at all.
  if (mode === 'gate' && approved === false) {
    return { status: 'changes-requested', exitCode: 0 };
  }
  return {
    status: approved === true ? 'approved' : 'advisory-findings',
    exitCode: 0,
  };
}
