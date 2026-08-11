// Pure helpers for validating inline review comments against the diff GitHub
// itself computes for a pull request.
//
// The CLI places comments against the local `git diff`, but GitHub anchors inline
// review comments to the PR diff it derives from its own merge-base. Those two
// diffs are usually identical, yet they can disagree (different merge-base,
// force-pushes, large/binary files GitHub omits a patch for). When they
// disagree, `pulls.createReview` rejects the WHOLE batch with
// `HTTP 422 Line could not be resolved`, losing the parent summary and every
// well-formed inline comment beside the one bad anchor.
//
// These functions re-derive the placeable line set from the GitHub PR files
// API (`GET /repos/{owner}/{repo}/pulls/{n}/files`) so the publisher can split
// inline comments into the ones GitHub will accept and the ones to downgrade
// into the parent review body. Pure (no I/O) so it is easy to unit-test; the
// paginated fetch lives in the publisher.

/**
 * @typedef {{ rightLines: Set<number>, leftLines: Set<number>, newPath: string, oldPath: string | null, hasPatch: boolean }} FileLines
 */

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse one file's unified `patch` (as returned by the GitHub PR files API,
 * which is just the `@@` hunks with no `diff --git`/`---`/`+++` headers) into
 * the line numbers GitHub will accept an inline comment on, split by side:
 *   - RIGHT: new-file line numbers (added + context lines)
 *   - LEFT:  old-file line numbers (deleted + context lines)
 *
 * @param {string} patch
 * @returns {{ rightLines: Set<number>, leftLines: Set<number> }}
 */
export function parseFilePatch(patch) {
  const rightLines = new Set();
  const leftLines = new Set();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of String(patch).split('\n')) {
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    const marker = line[0];
    if (marker === ' ') {
      rightLines.add(newLine);
      leftLines.add(oldLine);
      oldLine++;
      newLine++;
    } else if (marker === '+') {
      rightLines.add(newLine);
      newLine++;
    } else if (marker === '-') {
      leftLines.add(oldLine);
      oldLine++;
    } else if (marker === '\\') {
      // `\ No newline at end of file`: ignore, stay in the hunk.
    } else {
      // Anything else (blank trailing line, etc.) ends the hunk.
      inHunk = false;
    }
  }

  return { rightLines, leftLines };
}

/**
 * Build a map of placeable lines keyed by both the new path (`filename`) and,
 * for renames, the old path (`previous_filename`). Each entry carries its
 * `newPath` (the file's current name in the PR) so a comment matched under a
 * rename's old key can be rewritten to the path GitHub will accept. A file
 * GitHub returns without a `patch` (binary, or a diff too large to inline) is
 * recorded with `hasPatch: false` so callers can downgrade comments on it
 * rather than risk a 422.
 *
 * @param {Array<{ filename?: string, previous_filename?: string, patch?: string }>} files
 * @returns {Map<string, FileLines>}
 */
export function buildPlaceableMap(files) {
  /** @type {Map<string, FileLines>} */
  const byPath = new Map();
  if (!Array.isArray(files)) return byPath;

  for (const file of files) {
    if (!file || typeof file.filename !== 'string' || file.filename === '') {
      continue;
    }
    const oldPath =
      typeof file.previous_filename === 'string' && file.previous_filename !== ''
        ? file.previous_filename
        : null;
    const hasPatch = typeof file.patch === 'string' && file.patch !== '';
    const { rightLines, leftLines } = hasPatch
      ? parseFilePatch(file.patch)
      : { rightLines: new Set(), leftLines: new Set() };

    const entry = { rightLines, leftLines, newPath: file.filename, oldPath, hasPatch };
    byPath.set(file.filename, entry);
    if (oldPath) byPath.set(oldPath, entry);
  }

  return byPath;
}

/**
 * Whether `(path, line, side)` lands on a line GitHub will accept a comment on.
 *
 * @param {Map<string, FileLines>} placeable
 * @param {string} path
 * @param {number} line
 * @param {'LEFT' | 'RIGHT'} side
 * @returns {boolean}
 */
export function isPlaceable(placeable, path, line, side) {
  const file = placeable.get(path);
  if (!file || !file.hasPatch) return false;
  return side === 'RIGHT'
    ? file.rightLines.has(line)
    : file.leftLines.has(line);
}

/**
 * Split already-shape-validated inline comments into the ones GitHub will
 * accept and the ones to downgrade into the parent review body.
 *
 * Each comment is expected to have `path`, `line`, `side`, `body` and may carry
 * `start_line`/`start_side`. A comment whose primary anchor is not placeable is
 * downgraded whole; a comment whose primary anchor is placeable but whose
 * `start_line` is not is kept inline with the start anchor dropped (so one bad
 * range cannot turn an otherwise valid finding into a 422).
 *
 * @param {Array<object>} comments
 * @param {Map<string, FileLines>} placeable
 * @returns {{ inline: Array<object>, downgraded: Array<object> }}
 */
export function partitionInlineComments(comments, placeable) {
  /** @type {Array<object>} */
  const inline = [];
  /** @type {Array<object>} */
  const downgraded = [];

  for (const c of comments) {
    if (!isPlaceable(placeable, c.path, c.line, c.side)) {
      downgraded.push({
        ...c,
        reason: placeable.has(c.path)
          ? `${c.path}:${c.line} (${c.side}) is not part of the PR diff GitHub can resolve.`
          : `${c.path} is not among the files changed in this PR.`,
      });
      continue;
    }

    // When a comment is matched under a rename's old path, GitHub's
    // createReview still requires the file's *current* name for both sides, so
    // emit the entry's `newPath` rather than the old key we looked it up by.
    // `originalPath` records the key this comment was matched under, so a
    // caller can correlate the published location back to the finding. It is
    // bookkeeping, not part of the GitHub payload, and is dropped before the
    // plan is returned.
    const placed = {
      path: placeable.get(c.path).newPath,
      originalPath: c.path,
      line: c.line,
      side: c.side,
      body: c.body,
    };
    if (
      c.start_line !== undefined &&
      isPlaceable(placeable, c.path, c.start_line, c.start_side ?? c.side)
    ) {
      placed.start_line = c.start_line;
      if (c.start_side !== undefined) placed.start_side = c.start_side;
    }
    inline.push(placed);
  }

  return { inline, downgraded };
}
