import { readFile } from 'node:fs/promises';

// The CLI can exit successfully and still leave a file that carries no result,
// so the condition needs its own type: it is the review result that failed, not
// the publication that follows it.
export class ResultFileError extends Error {}

export async function readReviewResult(path) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    throw new ResultFileError(
      `The Tessl Code Review result file ${path} could not be read: ${error.message}`,
    );
  }
  if (contents.trim() === '') {
    throw new ResultFileError(
      `The Tessl Code Review result file ${path} is empty, so the review produced no result.`,
    );
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new ResultFileError(
      `The Tessl Code Review result file ${path} is not valid JSON: ${error.message}`,
    );
  }
}

export const NO_MATCHING_LENSES_REASON = 'no-matching-lenses';

/**
 * A successful review that deliberately has no publishable outcome: no
 * configured lens matched the changed paths. Terminal and not a failure, so the
 * discriminator lives beside the result it reads rather than with any one
 * caller.
 */
export function isNoMatchingLensesResult(result) {
  return (
    result?.status === 'skipped' && result?.reason === NO_MATCHING_LENSES_REASON
  );
}

/**
 * The receipt statuses that mean the review reached its pull request, and every
 * status this revision understands.
 *
 * Named rather than inferred from the absence of the failure cases: the CLI is
 * not pinned by this Action, so it can report a status this revision has never
 * heard of, and an unrecognised one must not read as a published review.
 */
export const PUBLISHED_STATUSES = new Set(['published', 'reused']);

export const KNOWN_RECEIPT_STATUSES = new Set([
  ...PUBLISHED_STATUSES,
  'superseded',
  'published-with-policy-fallback',
]);

const REVIEW_EVENTS = new Set(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']);

const isCommitSha = (value) =>
  typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
const isCount = (value) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * The published fields of the CLI's publication receipt, each with the domain
 * its value has to fall in.
 *
 * Both halves are needed. Naming the fields keeps one the CLI adds later out of
 * the artifact until that is a decision; bounding the values keeps a field that
 * is already published from carrying something other than what it is for — a
 * caller-selected CLI could otherwise put a diagnostic, or a credential, in
 * `publishedEvent` and have it uploaded verbatim.
 */
const RECEIPT_FIELDS = {
  status: (value) => KNOWN_RECEIPT_STATUSES.has(value),
  reviewId: (value) => isCount(value) && value > 0,
  intendedEvent: (value) => REVIEW_EVENTS.has(value),
  publishedEvent: (value) => REVIEW_EVENTS.has(value),
  inlineCount: isCount,
  unplacedCount: isCount,
  reviewedHeadSha: isCommitSha,
  currentHeadSha: isCommitSha,
};

/**
 * What the CLI reported it did with the review on the pull request, or
 * `undefined` when it published nothing recognisable. The CLI owns publication,
 * so this is read from its result rather than produced here.
 */
export function publicationReceipt(result) {
  const publication = result?.publication;
  if (!KNOWN_RECEIPT_STATUSES.has(publication?.status)) return undefined;
  const projected = {};
  for (const [field, isValid] of Object.entries(RECEIPT_FIELDS)) {
    if (isValid(publication[field])) projected[field] = publication[field];
  }
  return projected;
}
