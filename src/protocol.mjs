import {
  buildPlaceableMap,
  partitionInlineComments,
} from './pr-diff.mjs';

export const RUN_MARKER = '<!-- tessl-code-review:run:v1 -->';
export const FAILURE_MARKER = '<!-- tessl-code-review:failure:v1 -->';

// The reconciliation vocabulary this Action understands, and everything derived
// from it: the counts, the "Earlier findings" line, the thread-reply prefix,
// which entry wins for a prior finding, and whether that reply carries the
// current finding body. Declaration order is the order of the summary line.
//
// The CLI and this Action version independently, so either side can be ahead
// of the other. The contract is tolerate-and-report: an unrecognised category
// is counted and rendered with a neutral sentence, never dropped and never
// thrown on. One unknown value must not fail publication of an entire review.
const RECONCILIATION_CATEGORIES = {
  addressed: {
    summary: (count) => `${count} addressed`,
    reply: 'Addressed in the current revision.',
    priority: 0,
  },
  explained: {
    summary: (count) => `${count} explained`,
    reply: 'Not repeated: explained in the conversation.',
    priority: 0,
  },
  refuted: {
    summary: (count) => `${count} refuted`,
    reply: 'Not repeated: refuted in the conversation.',
    priority: 0,
  },
  declined: {
    summary: (count) => `${count} declined`,
    reply: 'Not repeated: declined by the author.',
    priority: 0,
  },
  remaining: {
    summary: (count) => `${count} still ${count === 1 ? 'applies' : 'apply'}`,
    reply: 'Still applies after re-review.',
    priority: 1,
    surfaced: true,
  },
  regressed: {
    summary: (count) => `${count} regressed`,
    reply: 'Regressed after an earlier fix and still applies.',
    priority: 2,
    surfaced: true,
  },
};

const UNRECOGNISED_CATEGORY = 'unrecognised';

export const NO_MATCHING_LENSES_REASON = 'no-matching-lenses';

// This successful CLI result deliberately has no publishable outcome. Keep
// the discriminator here beside the publication protocol so callers cannot
// accidentally turn a valid no-op into a publication failure.
export function isNoMatchingLensesResult(result) {
  return (
    result?.status === 'skipped' &&
    result?.reason === NO_MATCHING_LENSES_REASON
  );
}

// Own-property lookup only: a category named after something on
// `Object.prototype` must read as unknown, not as an inherited member.
function knownCategory(category) {
  return typeof category === 'string' &&
    Object.hasOwn(RECONCILIATION_CATEGORIES, category)
    ? RECONCILIATION_CATEGORIES[category]
    : undefined;
}

// An unknown category is still published, so reduce it to a bounded, inert slug
// before it reaches a comment body.
function normalizeCategory(category) {
  if (typeof category !== 'string') return UNRECOGNISED_CATEGORY;
  const slug = category
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, ' ')
    .trim()
    .slice(0, 32);
  return slug.length > 0 ? slug : UNRECOGNISED_CATEGORY;
}

// Known categories keep their own key; everything else is counted under its
// normalized slug so it survives into the counts instead of being dropped.
function countKey(category) {
  return knownCategory(category) ? category : normalizeCategory(category);
}

export function findingMarker(id) {
  return `<!-- tessl-code-review:finding:v1 id=${id} -->`;
}

// The second form is an earlier marker format, still accepted so a finding
// published under it keeps its thread.
export function findingIdFromBody(body) {
  const canonical =
    /<!--\s*tessl-code-review:finding:v1\s+id=([^\s>]+)\s*-->/.exec(
      String(body),
    )?.[1];
  if (canonical) return canonical;
  return /<!--\s*tessl-finding:([^\s>]+)\s*-->/.exec(String(body))?.[1];
}

export function attemptMarker(attemptId) {
  return `<!-- tessl-code-review:workflow-run:v1 id=${attemptId} -->`;
}

export function reconciliationMarker(priorFindingId, category) {
  // Records on the thread which disposition a reply carries. Known categories
  // are already slugs and pass through unchanged; normalizing keeps an unknown
  // or missing one from interpolating raw into the marker, which is part of the
  // published comment body.
  return `<!-- tessl-code-review:reconciliation:v1 id=${priorFindingId} category=${normalizeCategory(category)} -->`;
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Code Review result is missing ${label}.`);
  }
}

export function readOutcome(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('Code Review result must be an object.');
  }
  if (result.status !== 'ok' || !result.outcome) {
    throw new Error(
      result.failure?.message ?? 'Code Review did not produce an outcome.',
    );
  }
  const outcome = {
    ...result.outcome,
    reconciliation:
      result.outcome.reconciliation === undefined
        ? []
        : result.outcome.reconciliation,
  };
  assertString(outcome.runId, 'outcome.runId');
  assertString(outcome.judgement, 'outcome.judgement');
  assertString(outcome.subject?.change?.headRevision, 'reviewed head revision');
  if (typeof outcome.approved !== 'boolean') {
    throw new Error('Code Review result is missing outcome.approved.');
  }
  if (!Array.isArray(outcome.findings)) {
    throw new Error('Code Review result is missing outcome.findings.');
  }
  if (!Array.isArray(outcome.reconciliation)) {
    throw new Error('Code Review result is missing outcome.reconciliation.');
  }
  for (let i = 0; i < outcome.findings.length; i++) {
    if (typeof outcome.findings[i].requiresChanges !== 'boolean') {
      throw new Error(
        `Code Review finding at index ${i} must include boolean requiresChanges.`,
      );
    }
  }
  const computedApproved = !outcome.findings.some((f) => f.requiresChanges);
  if (outcome.approved !== computedApproved) {
    throw new Error(
      `outcome.approved is ${outcome.approved} but findings imply ${computedApproved}.`,
    );
  }
  return outcome;
}

function lensName(ref) {
  const selected = String(ref).split('#').at(-1) ?? String(ref);
  const segments = selected.split('/').filter(Boolean);
  const leaf =
    segments.at(-1) === 'SKILL.md'
      ? (segments.at(-2) ?? segments.at(-1) ?? selected)
      : (segments.at(-1) ?? selected);
  return leaf.replace(/^review-/, '');
}

function titleCase(value) {
  return value
    .split('-')
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
    .join(' ');
}

export function lensMetadata(refs) {
  const canonical = [...new Set((refs ?? []).map(String))];
  const visible = [...new Set(canonical.map(lensName))].map(titleCase);
  return {
    visible: visible.length > 0 ? visible.join(' · ') : undefined,
    marker:
      canonical.length > 0
        ? `<!-- tessl-code-review:lenses:v1 refs=${canonical.map(encodeURIComponent).join(',')} -->`
        : undefined,
  };
}

const SEVERITY_ORDER = ['critical', 'major', 'minor', 'nit'];

function severityLabel(severity) {
  const value = String(severity ?? '');
  if (value.length === 0) return value;
  return `${value[0].toUpperCase()}${value.slice(1).toLowerCase()}`;
}

function findingBody(finding) {
  const metadata = lensMetadata(finding.lensRefs);
  return [
    `**${severityLabel(finding.severity)} · ${finding.title}**`,
    '',
    finding.body,
    metadata.visible ? '' : undefined,
    metadata.visible ? `<sub>${metadata.visible}</sub>` : undefined,
    metadata.marker ? '' : undefined,
    metadata.marker,
    findingMarker(finding.id),
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

export function selectPriorReconciliation(entries) {
  // An unrecognised category ranks below every known one, so a known
  // disposition always wins the prior finding.
  const rank = (category) => knownCategory(category)?.priority ?? -1;
  const byPriorId = new Map();
  for (const entry of entries) {
    if (!entry.priorFindingId) continue;
    const current = byPriorId.get(entry.priorFindingId);
    if (!current || rank(entry.category) > rank(current.category)) {
      byPriorId.set(entry.priorFindingId, entry);
    }
  }
  return [...byPriorId.values()];
}

function unplacedFinding(finding, body, reason) {
  return {
    id: finding.id,
    title: finding.title,
    severity: finding.severity,
    body,
    path: finding.location?.path ?? finding.path,
    line: finding.location?.line ?? finding.line,
    side: finding.location?.side ?? finding.side ?? 'RIGHT',
    reason,
  };
}

function renderUnplaced(finding) {
  const location = [finding.path, finding.line].filter(Boolean).join(':');
  const where = location ? ` \`${location}\`` : '';
  const reason = finding.reason ? ` _(${finding.reason})_` : '';
  const body = finding.body.replace(/^/gm, '  ').trimEnd();
  return `- **Unplaced finding**${where}${reason}\n${body}`;
}

function findingListEntry(finding, note) {
  const label = finding.severity
    ? `**${severityLabel(finding.severity)}** · `
    : '';
  const location = [finding.path, finding.line].filter(Boolean).join(':');
  return [
    `- ${label}${finding.title}`,
    location ? `\n  \`${location}\`` : '',
    note ? `\n  ${note}` : '',
  ].join('');
}

// The compact list of this outcome's findings: those placed inline this round,
// then those whose thread already exists. Rendering both from one place keeps
// the list from disagreeing with the severity table above it.
function findingsSection(placed, continuing) {
  if (placed.length === 0 && continuing.length === 0) return [];
  return [
    '',
    '#### Findings',
    '',
    ...placed.map((finding) => findingListEntry(finding)),
    ...continuing.map((finding) =>
      findingListEntry(
        finding,
        'Still applies. Discussion continues on the existing review comment thread.',
      ),
    ),
  ];
}

export function buildPublicationPlan({ outcome, files, attemptId }) {
  const priorReconciliation = selectPriorReconciliation(outcome.reconciliation);
  const priorByCurrentId = new Map(
    priorReconciliation
      .filter((entry) => entry.findingId)
      .map((entry) => [entry.findingId, entry]),
  );

  const candidates = [];
  const intrinsicallyUnplaced = [];
  const continuing = [];
  for (const finding of outcome.findings) {
    const prior = priorByCurrentId.get(finding.id);
    // The CLI owns lifecycle reconciliation and records the aggregate state on
    // the finding. A composite may link several earlier findings with different
    // constituent categories, so deriving its publication state from whichever
    // reconciliation entry happens to be last would make publication
    // order-dependent. An outcome that omits the finding disposition falls back
    // to the prior entry's category.
    const disposition = finding.disposition ?? prior?.category;
    if (disposition === 'remaining') {
      // Already carries an inline comment from an earlier round, so a second
      // root comment would split one concern across two threads. It is still
      // one of this outcome's findings, so it stays in the severity table and
      // the findings list, and its list entry says where the thread lives.
      continuing.push({
        title: finding.title,
        severity: finding.severity,
        path: finding.location?.path,
        line: finding.location?.line,
      });
      continue;
    }
    const body = findingBody(finding);
    const location = finding.location;
    if (!location?.path || !location.line) {
      intrinsicallyUnplaced.push(
        unplacedFinding(finding, body, 'No commentable line was supplied.'),
      );
      continue;
    }
    candidates.push({
      id: finding.id,
      title: finding.title,
      severity: finding.severity,
      path: location.path,
      line: location.line,
      side: location.side ?? 'RIGHT',
      body,
    });
  }

  const partition = partitionInlineComments(
    candidates,
    buildPlaceableMap(files),
  );
  const downgraded = partition.downgraded.map((finding) =>
    unplacedFinding(finding, finding.body, finding.reason),
  );
  const unplaced = [...intrinsicallyUnplaced, ...downgraded];

  // Compact list of the findings that actually landed as inline comments.
  // Candidates and partition.inline are in the same relative order (downgraded
  // entries are skipped, not reordered), so we pair by index after filtering out
  // the downgraded ids; no round-trip through the comment body marker needed.
  const downgradedIds = new Set(partition.downgraded.map((d) => d.id));
  const placedCandidates = candidates.filter((c) => !downgradedIds.has(c.id));
  const placed = placedCandidates.map((candidate, i) => {
    const comment = partition.inline[i];
    return {
      severity: candidate.severity,
      title: candidate.title,
      path: comment.path,
      line: comment.line,
    };
  });

  // Counted from the entries themselves, seeded with the known categories so
  // the summary line keeps its declared order.
  const counts = new Map(
    Object.keys(RECONCILIATION_CATEGORIES).map((category) => [category, 0]),
  );
  for (const entry of priorReconciliation) {
    const key = countKey(entry.category);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // The heading follows `outcome.approved`, and the requested-change count is
  // the number of findings marked `requiresChanges: true`. The verdict is never
  // inferred from severity, and the prose judgement is never parsed.
  const requestedChangeCount = outcome.findings.filter(
    (finding) => finding.requiresChanges === true,
  ).length;
  const verdict = outcome.approved === true
    ? '### Changes approved'
    : `### Changes requested (${requestedChangeCount})`;

  const shared = ['## Tessl Code Review', '', verdict, '', outcome.judgement];

  // Every finding in the outcome is counted, whether it gained an inline
  // comment this round or continues on an earlier thread, so the table and the
  // findings list below describe the same set the headline counts.
  const severityRows = SEVERITY_ORDER.map((severity) => [
    severity,
    outcome.findings.filter(
      (entry) => String(entry.severity).toLowerCase() === severity,
    ).length,
  ]).filter(([, count]) => count > 0);
  if (severityRows.length > 0) {
    shared.push(
      '',
      '| Severity | Findings |',
      '| --- | ---: |',
      ...severityRows.map(
        ([severity, count]) => `| ${severityLabel(severity)} | ${count} |`,
      ),
    );
  }

  const tail = [];

  if (priorReconciliation.length > 0) {
    const parts = [];
    for (const [category, count] of counts) {
      if (count === 0) continue;
      const known = knownCategory(category);
      parts.push(known ? known.summary(count) : `${count} ${category}`);
    }
    tail.push('', `**Earlier findings:** ${parts.join(' · ')}`);
  }

  if (unplaced.length > 0) {
    tail.push(
      '',
      '<details>',
      `<summary>Findings outside changed lines (${unplaced.length})</summary>`,
      '',
      ...unplaced.map(renderUnplaced),
      '</details>',
    );
  }
  tail.push(
    '',
    'Mention `@tessl-code-review` after fixes or replies are ready to run another review.',
  );
  tail.push('', RUN_MARKER, attemptMarker(attemptId));

  // baseBody lists no inline findings so buildFallbackBody does not claim
  // findings are inline when the 422 path placed none. Continuing findings are
  // unaffected by that failure, so they are listed in both bodies.
  const baseBody = [...shared, ...findingsSection([], continuing), ...tail].join(
    '\n',
  );
  const body = [
    ...shared,
    ...findingsSection(placed, continuing),
    ...tail,
  ].join('\n');

  return {
    body,
    baseBody,
    inline: partition.inline.map(
      ({ originalPath: _originalPath, id: _id, ...c }) => c,
    ),
    unplaced,
    priorReconciliation,
  };
}

export function buildFallbackBody(plan) {
  if (plan.inline.length === 0) return plan.body;
  const fallback = plan.inline.map((comment, index) => ({
    title: `Finding ${index + 1}`,
    body: comment.body,
    path: comment.path,
    line: comment.line,
    side: comment.side,
    reason: 'GitHub could not resolve the inline location.',
  }));
  // Use baseBody (no compact inline list) so the fallback body does not claim
  // findings are placed inline when none were.
  return [
    plan.baseBody,
    '',
    '<details>',
    `<summary>Additional findings outside changed lines (${fallback.length})</summary>`,
    '',
    ...fallback.map(renderUnplaced),
    '</details>',
  ].join('\n');
}

// Replies keep the order GitHub returned them in, which the review-comments
// endpoint sorts by creation time ascending.
export function groupReviewCommentThreads(comments) {
  const roots = new Map();
  for (const comment of comments) {
    if (comment.in_reply_to_id == null) {
      roots.set(String(comment.id), { root: comment, replies: [] });
    }
  }
  for (const comment of comments) {
    if (comment.in_reply_to_id == null) continue;
    const thread = roots.get(String(comment.in_reply_to_id));
    if (thread) thread.replies.push(comment);
  }
  return [...roots.values()];
}

function lastIndexWhere(items, predicate) {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}

// This Action's own replies carry a reconciliation marker, so the marker is what
// identifies them. Being a bot account is not enough: a third-party review bot
// posts under one too, and its comment is conversation activity that this Action
// still owes an answer to.
// This Action puts the marker at the start of its own line, and GitHub's quote
// reply copies the quoted markdown behind a `> ` prefix, so anchoring to the
// line start keeps an author quoting a reply from reading as the Action.
function isOwnReply(comment) {
  return /^<!--\s*tessl-code-review:reconciliation:v1\s/m.test(
    String(comment.body ?? ''),
  );
}

export function planConversationReplies({
  reconciliation,
  findings,
  reviewComments,
}) {
  const findingById = new Map(findings.map((finding) => [finding.id, finding]));
  const threads = groupReviewCommentThreads(reviewComments);
  const replies = [];

  for (const entry of reconciliation) {
    const matching = threads.filter(
      (thread) => findingIdFromBody(thread.root.body) === entry.priorFindingId,
    );
    if (matching.length === 0) continue;
    const target = matching.at(-1);
    // Answer whenever anyone else has spoken since this Action last did. A
    // disposition that has not changed still needs answering when the author
    // has since claimed a fix, so an unresolved finding is never left with that
    // claim as its thread's last word. When nothing new has been said the
    // thread is left alone, which also keeps a republished attempt from
    // duplicating a reply it already posted.
    const lastOtherReply = lastIndexWhere(
      target.replies,
      (reply) => !isOwnReply(reply),
    );
    if (lastOtherReply < 0) continue;
    if (lastOtherReply < lastIndexWhere(target.replies, isOwnReply)) continue;
    const marker = reconciliationMarker(entry.priorFindingId, entry.category);
    const finding = entry.findingId
      ? findingById.get(entry.findingId)
      : undefined;
    const known = knownCategory(entry.category);
    // A category this Action does not know still gets a sentence: the reply is
    // posted publicly, so it must never open with `undefined`.
    const prefix =
      known?.reply ??
      `Reconciled in the current revision as \`${normalizeCategory(entry.category)}\`.`;
    // A settled constituent may remain linked to a live composite finding for
    // provenance. Its own thread should explain why that constituent is
    // settled, not repeat the still-active composite body. Surfaced entries use
    // the current finding body so the actionable concern stays visible.
    const surfaced = known?.surfaced === true;
    const detail = surfaced ? (finding?.body ?? entry.note) : entry.note;
    replies.push({
      rootCommentId: target.root.id,
      body: `${prefix}${detail ? ` ${detail}` : ''}\n\n${marker}`,
    });
  }
  return replies;
}
