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
 * The published fields of the CLI's publication receipt, named one by one.
 *
 * Projected rather than passed through for the same reason every other section
 * of the artifact is: a field the CLI adds later stays out until it is added
 * here and to the documented schema, so no new CLI output reaches an artifact
 * reader without that decision being made.
 */
const RECEIPT_FIELDS = [
  'status',
  'reviewId',
  'intendedEvent',
  'publishedEvent',
  'inlineCount',
  'unplacedCount',
  'reviewedHeadSha',
  'currentHeadSha',
];

/**
 * What the CLI reported it did with the review on the pull request, or
 * `undefined` when it published nothing. The CLI owns publication, so this is
 * read from its result rather than produced here.
 */
export function publicationReceipt(result) {
  const publication = result?.publication;
  if (typeof publication?.status !== 'string') return undefined;
  const projected = {};
  for (const field of RECEIPT_FIELDS) {
    const value = publication[field];
    if (typeof value === 'string' || typeof value === 'number') {
      projected[field] = value;
    }
  }
  return projected;
}
