/**
 * The one sentence a maintainer needs when a run failed before it reviewed
 * anything.
 *
 * The CLI already reports why it stopped, as a `stage`/`kind` pair and an
 * actionable `message`. Until now the Action read that only to decide a
 * conclusion, so every failure reached the pull request as the same sentence
 * pointing at the workflow run: a profile naming a lens file that does not
 * exist was indistinguishable from a crashed CLI, and telling them apart meant
 * opening the run and scrolling the log.
 *
 * Only the stages below are surfaced. Their messages describe the run's own
 * configuration and inputs: a flag, a profile, a model, a credential, which is
 * what a maintainer can act on, and the CLI writes them itself rather than
 * assembling them from anything it read. `execution` and `internal` are
 * withheld because a message from either can carry model output or an arbitrary
 * exception, and `provider-error` because it can echo a provider's response
 * body verbatim. Those keep the generic sentence and the workflow run.
 */

const SURFACED_STAGES = new Set([
  'validation',
  'authentication',
  'credit',
  'preparation',
  'profile',
  'model-validation',
  'executor-selection',
]);

const WITHHELD_KINDS = new Set(['provider-error']);

// Long enough for the CLI's longest configuration sentence, short enough that a
// message which is not one cannot fill a comment.
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
 * recognise, a withheld stage, and an absent or empty message all return
 * `undefined`, so a caller renders its generic sentence unchanged.
 */
export function configurationFailureReason(result) {
  const failure = result?.failure;
  if (result?.status !== 'failed') return undefined;
  if (failure === null || typeof failure !== 'object') return undefined;
  if (!SURFACED_STAGES.has(failure.stage)) return undefined;
  if (WITHHELD_KINDS.has(failure.kind)) return undefined;
  if (typeof failure.message !== 'string') return undefined;
  const reason = inlineSafe(failure.message);
  return reason === '' ? undefined : reason;
}
