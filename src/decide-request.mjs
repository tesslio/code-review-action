#!/usr/bin/env node

/**
 * Decide whether the event that started this run is a request for a review.
 *
 * A comment requests a review by mentioning the review handle. That decision
 * used to belong to every caller, which meant one rule written four times in two
 * languages, disagreeing on case, on token boundaries, and on whether a comment
 * body reached the matcher intact. It belongs here: a caller cannot get it wrong,
 * and changing it changes it everywhere.
 *
 * What a caller keeps is the coarse `if:` that stops GitHub starting a runner for
 * every comment in the repository. A workflow expression cannot match a token
 * boundary, so that filter is deliberately loose and this step is what makes it
 * exact.
 *
 * An event that is not a comment is always a request: a caller that subscribes to
 * `pull_request` has already said what it wants reviewed.
 */

import { appendFile } from 'node:fs/promises';

import { requiredEnv } from './env.mjs';

const HANDLE = '@tessl-code-review';
/**
 * The handle must appear as a whole token, so `@tessl-code-reviewer` and
 * `@tessl-code-review-bot` are not requests. Case-insensitive: GitHub treats
 * mentions that way, and a reader typing `@Tessl-Code-Review` means it.
 */
const MENTION = new RegExp(
  `(^|[^a-zA-Z0-9_-])${HANDLE}([^a-zA-Z0-9_-]|$)`,
  'i',
);
const COMMENT_EVENTS = new Set([
  'issue_comment',
  'pull_request_review_comment',
]);
const ASSOCIATIONS = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
  'CONTRIBUTOR',
  'FIRST_TIME_CONTRIBUTOR',
  'FIRST_TIMER',
  'MANNEQUIN',
  'NONE',
]);

/** The associations a caller will accept, or `undefined` for any. */
function parseAllowed(raw) {
  const values = (raw ?? '')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0);
  if (values.length === 0) return undefined;
  const unknown = values.filter((value) => !ASSOCIATIONS.has(value));
  if (unknown.length > 0) {
    throw new Error(
      `allowed-associations must name GitHub author associations, got ${unknown.join(', ')}.`,
    );
  }
  return new Set(values);
}

function decide({ eventName, body, association, allowed }) {
  if (!COMMENT_EVENTS.has(eventName)) return { requested: true };
  if (!MENTION.test(body ?? '')) {
    return {
      requested: false,
      reason: `the comment does not mention ${HANDLE} as a whole token`,
    };
  }
  if (allowed !== undefined && !allowed.has((association ?? '').toUpperCase())) {
    return {
      requested: false,
      reason: `the comment author's association is not one this caller accepts`,
    };
  }
  return { requested: true };
}

const decision = decide({
  eventName: requiredEnv('EVENT_NAME'),
  body: process.env.COMMENT_BODY,
  association: process.env.COMMENT_ASSOCIATION,
  allowed: parseAllowed(process.env.ALLOWED_ASSOCIATIONS),
});

if (!decision.requested) {
  console.log(`::notice::No review requested: ${decision.reason}.`);
}

await appendFile(
  requiredEnv('GITHUB_OUTPUT'),
  `requested=${decision.requested}\nstatus=${decision.requested ? '' : 'not-requested'}\n`,
  'utf8',
);
