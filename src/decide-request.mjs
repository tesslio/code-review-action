#!/usr/bin/env node

/**
 * Decide whether the event that started this run is a request for a review.
 *
 * A comment requests a review by mentioning the review handle in its own voice.
 * Deciding that in a caller means every caller reimplements one rule in a workflow
 * expression plus a shell step, where case, token boundaries, Markdown and shell
 * quoting are each easy to get subtly wrong. It belongs here: a caller cannot get
 * it wrong, and changing it changes it for every caller at once.
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
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const QUOTE = /^ {0,3}>/;

/**
 * The comment with the parts it is showing or quoting taken out: fenced blocks,
 * quoted lines, and inline code spans, which close only on a backtick run of
 * their own length and may cross lines.
 *
 * A comment writing about the reviewer puts the handle in backticks, and one
 * quoting an earlier round carries that round's handle along with it. Neither is
 * asking for anything, and treating them as requests is how a review round
 * starts that nobody wanted.
 */
function ownVoice(body) {
  const lines = [];
  let fence = null;
  for (const line of body.split('\n')) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`).test(line)) {
        fence = null;
      }
      continue;
    }
    const opening = FENCE.exec(line);
    // A backtick fence's info string may not itself contain a backtick, so a
    // line like ```` ```lang` ```` opens nothing. Treating it as a fence would
    // discard the rest of the comment, and a real request with it.
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = { char: opening[1][0], length: opening[1].length };
      continue;
    }
    if (QUOTE.test(line)) continue;
    lines.push(line);
  }
  return withoutCodeSpans(lines.join('\n'));
}

function withoutCodeSpans(text) {
  const runs = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '`') continue;
    const start = index;
    while (text[index] === '`') index += 1;
    runs.push({ start, length: index - start });
    index -= 1;
  }

  // Each run's partner is the next run of the same length, resolved in one pass
  // so a comment full of unmatched backticks cannot be scanned repeatedly.
  const partner = new Array(runs.length).fill(-1);
  const nextOfLength = new Map();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const seen = nextOfLength.get(runs[index].length);
    if (seen !== undefined) partner[index] = seen;
    nextOfLength.set(runs[index].length, index);
  }

  let out = '';
  let cursor = 0;
  let index = 0;
  while (index < runs.length) {
    if (partner[index] === -1) {
      index += 1;
      continue;
    }
    const close = runs[partner[index]];
    out += `${text.slice(cursor, runs[index].start)} `;
    cursor = close.start + close.length;
    index = partner[index] + 1;
  }
  return out + text.slice(cursor);
}
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

/**
 * The comment authors a caller named as permitted to request an approval.
 *
 * Read here as well as by the CLI because this gate runs first: a GitHub App
 * comments with association `NONE` whatever its permissions, so an association
 * allowlist that omits `NONE` refuses the very App the caller named — and
 * refuses it as "no review requested", so it gets neither the approval it asked
 * for nor the refusal explaining why not.
 */
function parseApproverLogins(raw) {
  return new Set(
    (raw ?? '')
      .split(/[,\n]/)
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  );
}

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

function decide({
  eventName,
  body,
  association,
  allowed,
  approvers,
  author,
  prAuthor,
}) {
  if (!COMMENT_EVENTS.has(eventName)) return { requested: true };
  if (!MENTION.test(ownVoice(body ?? ''))) {
    return {
      requested: false,
      reason: `the comment does not mention ${HANDLE} as a whole token outside code and quotes`,
    };
  }
  if (allowed === undefined) return { requested: true };
  // The author of a pull request may always ask for it to be reviewed. They
  // already decide what is in it, so an allowlist cannot be protecting anything
  // by refusing them — and GitHub's own association value refuses them by
  // accident: a `pull_request_review_comment` payload reports the author of the
  // branch's commits as CONTRIBUTOR, where the same person on the same pull
  // request is MEMBER in an `issue_comment` payload and in the REST API.
  // GitHub logins are case-insensitive, so the same account can arrive spelled
  // two ways and must still be one person.
  const commenter = (author ?? '').toLowerCase();
  const owner = (prAuthor ?? '').toLowerCase();
  if (commenter !== '' && commenter === owner) {
    return { requested: true };
  }
  // A caller that named an approver has already decided that author may ask for
  // something stronger than a review, so refusing them at the association gate
  // would contradict the caller's own configuration.
  if (commenter !== '' && approvers.has(commenter)) {
    return { requested: true };
  }
  if (!allowed.has((association ?? '').toUpperCase())) {
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
  approvers: parseApproverLogins(process.env.APPROVER_LOGINS),
  author: process.env.COMMENT_AUTHOR,
  prAuthor: process.env.PR_AUTHOR,
});

if (!decision.requested) {
  console.log(`::notice::No review requested: ${decision.reason}.`);
}

await appendFile(
  requiredEnv('GITHUB_OUTPUT'),
  `requested=${decision.requested}\nstatus=${decision.requested ? '' : 'not-requested'}\n`,
  'utf8',
);
