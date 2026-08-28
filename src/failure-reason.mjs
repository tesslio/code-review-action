/**
 * The one sentence a maintainer needs when a run failed before it reviewed
 * anything.
 *
 * The CLI reports why it stopped as a `stage`/`kind` pair and a `message`.
 * Without a reason, every such failure reads the same on the pull request — a
 * profile that names a file which is not there, and a CLI that crashed, both
 * arrive as one sentence pointing at the workflow run.
 *
 * The check run and the notice are as public as the repository, so this is an
 * allowlist of the kinds whose message is composed from a fixed sentence and
 * the caller's own input: a flag they passed, a path in their profile, a name
 * they typed. A kind that is not named here is withheld, whatever its stage,
 * because a message can also describe the account, the provider, or the review
 * itself. Withholding is also the answer for a kind this revision has never
 * heard of, so a later CLI cannot widen what is published by adding one.
 */

const SURFACED_KINDS = new Set([
  // A flag combination, selector, or request the CLI rejected.
  'invalid-selector',
  'invalid-request',
  'publish-with-fixture',
  'restricted-override',
  'too-many-lenses',
  // The caller's own profile file: its path, and what is wrong inside it.
  'invalid-profile-file',
  // A profile name that is not one of the named profiles.
  'unknown-profile',
  // A fixed sentence naming the login command.
  'authentication-required',
]);

// Long enough for the longest sentence this allowlist admits, short enough that
// a message which is not one cannot fill a comment.
const MAX_LENGTH = 500;

/**
 * Reduce a message to a single line that is safe inside a Markdown code span.
 *
 * Control characters and newlines go because the reason is rendered inline; a
 * backtick goes because it would close the span and let the rest of the message
 * render as Markdown.
 */
function inlineSafe(message) {
  const collapsed = message
    .replace(/[\u0000-\u001F\u007F]+/gu, ' ')
    .replace(/`/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
  return collapsed.length > MAX_LENGTH
    ? `${collapsed.slice(0, MAX_LENGTH - 1)}…`
    : collapsed;
}

/**
 * The CLI's own reason for stopping, ready to render inside a code span, or
 * `undefined` when there is none to surface. A result this revision does not
 * recognise, a kind outside the allowlist, and an absent or empty message all
 * return `undefined`, so a caller renders its generic sentence unchanged.
 */
export function configurationFailureReason(result) {
  const failure = result?.failure;
  if (result?.status !== 'failed') return undefined;
  if (failure === null || typeof failure !== 'object') return undefined;
  if (!SURFACED_KINDS.has(failure.kind)) return undefined;
  if (typeof failure.message !== 'string') return undefined;
  const reason = inlineSafe(failure.message);
  return reason === '' ? undefined : reason;
}
