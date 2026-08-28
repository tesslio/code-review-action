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
 * allowlist of the failures whose message is composed from a fixed sentence and
 * the caller's own configuration: a flag they passed, a name they typed, or a
 * path read from a profile in the repository being reviewed. A failure that is
 * not named here is withheld, because a message can also describe the account,
 * the provider, or the review itself.
 *
 * Each entry names the stage and the kind together. The CLI is the caller's to
 * choose and versions independently of this Action, so the pair is what pins a
 * message to the failure this allowlist was written against: a later CLI that
 * reuses one of these kinds at another stage, or adds a stage of its own,
 * publishes nothing until an entry here says otherwise.
 */

const SURFACED_FAILURES = new Set([
  // A flag combination, selector, or request the CLI rejected.
  'validation:invalid-selector',
  'validation:invalid-request',
  'validation:publish-with-fixture',
  'validation:restricted-override',
  'validation:too-many-lenses',
  // The caller's own profile file: its path, and what is wrong inside it.
  'validation:invalid-profile-file',
  // A profile name that is not one of the named profiles.
  'profile:unknown-profile',
  // A fixed sentence naming the login command.
  'authentication:authentication-required',
]);

// Long enough for the longest sentence this allowlist admits, short enough that
// a message which is not one cannot fill a comment.
const MAX_LENGTH = 500;

/**
 * Reduce a message to a single line that is safe inside a Markdown code span.
 *
 * Control characters and newlines go because the reason is rendered inline. A
 * backtick goes because it would close the span and let the rest of the message
 * render as Markdown. Format characters go because a bidirectional override
 * renders text in an order other than the one it is written in, and a code span
 * does not stop that.
 */
function inlineSafe(message) {
  const collapsed = message
    .replace(/[\u0000-\u001F\u007F]+/gu, ' ')
    .replace(/\p{Cf}+/gu, '')
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
 * recognise, a stage and kind outside the allowlist, and an absent or empty
 * message all return `undefined`, so a caller renders its generic sentence
 * unchanged.
 */
export function configurationFailureReason(result) {
  const failure = result?.failure;
  if (result?.status !== 'failed') return undefined;
  if (failure === null || typeof failure !== 'object') return undefined;
  const form = `${failure.stage}:${failure.kind}`;
  if (!SURFACED_FAILURES.has(form)) return undefined;
  if (typeof failure.message !== 'string') return undefined;
  const reason = inlineSafe(failure.message);
  return reason === '' ? undefined : reason;
}
