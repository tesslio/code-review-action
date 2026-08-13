import { isNoMatchingLensesResult } from './protocol.mjs';

export function reviewConclusion({
  mode,
  reviewExitCode,
  publishExitCode,
  result,
  publication,
}) {
  if (mode !== 'advisory' && mode !== 'gate') {
    throw new Error('mode must be advisory or gate.');
  }
  if (reviewExitCode !== '0') {
    return { status: 'technical-failure', exitCode: 1 };
  }
  if (isNoMatchingLensesResult(result)) {
    return { status: 'skipped-no-matching-lenses', exitCode: 0 };
  }
  // Only a boolean verdict decides a gate. An absent verdict, or a value such
  // as the string "false" that a truthiness test would accept, establishes
  // nothing about the reviewed head, so gate mode fails closed instead of
  // passing the head through. A verdict this malformed also stops publication,
  // and it is checked before the publication result so that the status names
  // the missing verdict rather than its effect.
  const approved = result?.outcome?.approved;
  if (mode === 'gate' && typeof approved !== 'boolean') {
    return { status: 'gate-verdict-failure', exitCode: 1 };
  }
  // A publication that failed for any other reason published nothing, so a
  // verdict it carried decides nothing either.
  if (publishExitCode !== '0') {
    return { status: 'publication-failure', exitCode: 1 };
  }
  if (publication?.status === 'superseded') {
    return { status: 'superseded', exitCode: 1 };
  }
  if (publication?.status === 'published-with-policy-fallback') {
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
