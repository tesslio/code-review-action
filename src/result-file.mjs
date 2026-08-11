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
