import { isNoMatchingLensesResult } from './result-file.mjs';

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
export function reviewConclusion({ mode, reviewExitCode, result }) {
  if (mode !== 'advisory' && mode !== 'gate') {
    throw new Error('mode must be advisory or gate.');
  }
  if (isNoMatchingLensesResult(result)) {
    return { status: 'skipped-no-matching-lenses', exitCode: 0 };
  }

  const publication = result?.publication;
  const reviewSucceeded = reviewExitCode === '0';

  // A run that exited non-zero having still produced an outcome failed to
  // publish, not to review. Reporting it as a technical failure would send a
  // maintainer looking at the review instead of at the permission or the head
  // that actually stopped it.
  if (!reviewSucceeded) {
    return result?.status === 'ok' && result?.outcome !== undefined
      ? { status: 'publication-failure', exitCode: 1 }
      : { status: 'technical-failure', exitCode: 1 };
  }

  // Only a boolean verdict decides a gate. An absent one establishes nothing
  // about the reviewed head, so gate mode fails closed rather than passing it.
  const approved = result?.outcome?.approved;
  if (mode === 'gate' && typeof approved !== 'boolean') {
    return { status: 'gate-verdict-failure', exitCode: 1 };
  }

  // The review succeeded and was asked to publish, so a missing receipt means
  // the publication never reported a terminal state.
  if (publication === undefined) {
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
