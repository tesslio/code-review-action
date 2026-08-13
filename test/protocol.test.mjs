import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildFallbackBody,
  buildPublicationPlan,
  lensMetadata,
  findingIdFromBody,
  findingMarker,
  isNoMatchingLensesResult,
  NO_MATCHING_LENSES_REASON,
  planConversationReplies,
  readOutcome,
  reconciliationMarker,
  selectPriorReconciliation,
} from '../src/protocol.mjs';

const PATCH = ['@@ -1,2 +1,2 @@', ' unchanged', '-old', '+new'].join('\n');

function outcome(overrides = {}) {
  const findings = overrides.findings ?? [];
  return {
    schemaVersion: 1,
    runId: 'run-1',
    subject: {
      schemaVersion: 1,
      repository: 'https://github.com/acme/widgets.git',
      change: {
        baseRevision: 'base',
        headRevision: 'head',
        headKind: 'commit',
      },
    },
    effort: 'standard',
    judgement: 'The change is sound apart from the findings below.',
    // Derived from the per-finding flags unless a case overrides it explicitly.
    approved: !findings.some((f) => f.requiresChanges),
    findings,
    reconciliation: [],
    ...overrides,
  };
}

function finding(overrides = {}) {
  return {
    id: 'finding-1',
    title: 'Validate the input',
    body: 'The value is used before validation.',
    severity: 'major',
    evidence: [],
    lensRefs: ['tessl/code-review@0.0.1#review-code-legibility'],
    disposition: 'new',
    requiresChanges: true,
    location: { path: 'new.ts', line: 2, side: 'RIGHT' },
    ...overrides,
  };
}

test('canonical and earlier finding markers round-trip', () => {
  assert.equal(findingIdFromBody(findingMarker('crf-1')), 'crf-1');
  assert.equal(
    findingIdFromBody('text <!-- tessl-finding:earlier-id -->'),
    'earlier-id',
  );
});

test('recognizes the successful no-match result as non-publishable', () => {
  assert.equal(NO_MATCHING_LENSES_REASON, 'no-matching-lenses');
  assert.equal(
    isNoMatchingLensesResult({
      status: 'skipped',
      reason: NO_MATCHING_LENSES_REASON,
    }),
    true,
  );
  assert.equal(
    isNoMatchingLensesResult({
      status: 'ok',
      reason: NO_MATCHING_LENSES_REASON,
      outcome: {},
    }),
    false,
  );
});

test('lens attribution is readable and canonical', () => {
  const metadata = lensMetadata([
    'tessl/code-review@0.0.1#review-code-legibility',
    'tessl/code-review@0.0.1#review-local-precedent',
  ]);
  assert.equal(metadata.visible, 'Code Legibility · Local Precedent');
  assert.match(metadata.marker, /lenses:v1/);
  assert.match(metadata.marker, /review-code-legibility/);
});

test('lens attribution uses the skill directory rather than SKILL.md', () => {
  const metadata = lensMetadata([
    'reviews/skills/review-functional-correctness/SKILL.md',
    'reviews/skills/review-api-contract/SKILL.md',
  ]);
  assert.equal(metadata.visible, 'Functional Correctness · Api Contract');
  assert.match(metadata.marker, /SKILL.md/);
});

test('places findings, rewrites renamed paths and preserves marker metadata', () => {
  const plan = buildPublicationPlan({
    outcome: outcome({
      findings: [
        finding({ location: { path: 'old.ts', line: 2, side: 'LEFT' } }),
      ],
    }),
    files: [{ filename: 'new.ts', previous_filename: 'old.ts', patch: PATCH }],
    attemptId: 'workflow-1',
  });
  assert.equal(plan.inline.length, 1);
  assert.equal(plan.inline[0].path, 'new.ts');
  assert.match(plan.inline[0].body, /finding:v1 id=finding-1/);
  assert.match(plan.inline[0].body, /\*\*Major · Validate the input\*\*/);
  assert.match(plan.inline[0].body, /<sub>Code Legibility<\/sub>/);
});

test('safely moves a finding on a deleted file into the summary', () => {
  const plan = buildPublicationPlan({
    outcome: outcome({ findings: [finding()] }),
    files: [{ filename: 'new.ts', status: 'removed' }],
    attemptId: 'workflow-1',
  });
  assert.equal(plan.inline.length, 0);
  assert.equal(plan.unplaced.length, 1);
  assert.match(plan.body, /Findings outside changed lines \(1\)/);
  assert.match(plan.body, /finding:v1 id=finding-1/);
});

test('accepts a successful outcome that carries no reconciliation data', () => {
  const value = outcome();
  delete value.reconciliation;
  const parsed = readOutcome({ status: 'ok', outcome: value });
  assert.deepEqual(parsed.reconciliation, []);
});

test('readOutcome rejects a finding with a missing requiresChanges flag', () => {
  const badFinding = finding();
  delete badFinding.requiresChanges;
  assert.throws(
    () => readOutcome({ status: 'ok', outcome: outcome({ findings: [badFinding] }) }),
    /boolean requiresChanges/,
  );
});

test('readOutcome rejects a non-boolean requiresChanges flag', () => {
  assert.throws(
    () =>
      readOutcome({
        status: 'ok',
        outcome: outcome({
          findings: [finding({ requiresChanges: 'true' })],
        }),
      }),
    /boolean requiresChanges/,
  );
});

test('readOutcome rejects outcome.approved that disagrees with per-finding flags', () => {
  assert.throws(
    () =>
      readOutcome({
        status: 'ok',
        outcome: outcome({ approved: false, findings: [] }),
      }),
    /findings imply true/,
  );
  assert.throws(
    () =>
      readOutcome({
        status: 'ok',
        outcome: outcome({ approved: true, findings: [finding({ requiresChanges: true })] }),
      }),
    /findings imply false/,
  );
});

test('keeps the strongest reconciliation entry for each earlier finding', () => {
  const selected = selectPriorReconciliation([
    { priorFindingId: 'prior-1', category: 'addressed' },
    { priorFindingId: 'prior-1', category: 'remaining' },
    { priorFindingId: 'prior-1', category: 'regressed' },
    { priorFindingId: 'prior-2', category: 'explained' },
  ]);
  assert.deepEqual(
    selected.map(({ priorFindingId, category }) => ({
      priorFindingId,
      category,
    })),
    [
      { priorFindingId: 'prior-1', category: 'regressed' },
      { priorFindingId: 'prior-2', category: 'explained' },
    ],
  );
});

test('does not create a duplicate root for a remaining prior finding', () => {
  const current = finding({ disposition: 'remaining' });
  const plan = buildPublicationPlan({
    outcome: outcome({
      findings: [current],
      reconciliation: [
        {
          category: 'remaining',
          title: current.title,
          note: 'The issue is still present.',
          findingId: current.id,
          priorFindingId: 'prior-1',
        },
      ],
    }),
    files: [{ filename: 'new.ts', patch: PATCH }],
    attemptId: 'workflow-2',
  });
  assert.equal(plan.inline.length, 0);
  assert.equal(plan.unplaced.length, 0);
  assert.match(plan.body, /\*\*Earlier findings:\*\* 1 still applies/);
  assert.match(plan.body, /### Changes requested \(1\)/);
});

test('does not republish a remaining composite regardless of constituent order', () => {
  const current = finding({ disposition: 'remaining' });
  const remaining = {
    category: 'remaining',
    title: 'Preserve explicit review requests',
    note: 'This constraint still applies.',
    findingId: current.id,
    priorFindingId: 'prior-1',
  };
  const addressed = {
    category: 'addressed',
    title: 'Serialize automatic reviews',
    note: 'This constraint is satisfied.',
    findingId: current.id,
    priorFindingId: 'prior-2',
  };

  for (const reconciliation of [
    [remaining, addressed],
    [addressed, remaining],
  ]) {
    const plan = buildPublicationPlan({
      outcome: outcome({ findings: [current], reconciliation }),
      files: [{ filename: 'new.ts', patch: PATCH }],
      attemptId: 'workflow-composite-remaining',
    });
    assert.equal(plan.inline.length, 0);
    assert.equal(plan.unplaced.length, 0);
    // No second root comment, but the finding is still one this outcome holds,
    // so it stays in the table and the list.
    assert.match(plan.body, /\| Major \| 1 \|/);
    assert.match(
      plan.body,
      /\*\*Earlier findings:\*\* 1 addressed · 1 still applies/,
    );
  }
});

test('a new finding and a still-applying prior reconcile across every surface', () => {
  const carried = finding({
    id: 'finding-carried',
    title: 'Provide a safe restore procedure',
    disposition: 'remaining',
    location: { path: 'README.md', line: 2, side: 'RIGHT' },
  });
  const raised = finding({
    id: 'finding-raised',
    title: 'Do not delete every overlapping ruleset',
    location: { path: 'new.ts', line: 2, side: 'RIGHT' },
  });
  const plan = buildPublicationPlan({
    outcome: outcome({
      findings: [carried, raised],
      reconciliation: [
        {
          category: 'remaining',
          note: 'The issue is still present.',
          findingId: carried.id,
          priorFindingId: 'prior-1',
        },
      ],
    }),
    files: [{ filename: 'new.ts', patch: PATCH }],
    attemptId: 'workflow-reconciled',
  });

  assert.match(plan.body, /### Changes requested \(2\)/);
  assert.match(plan.body, /\| Major \| 2 \|/);
  assert.match(
    plan.body,
    /- \*\*Major\*\* · Do not delete every overlapping ruleset\n {2}`new\.ts:2`/,
  );
  assert.match(
    plan.body,
    /- \*\*Major\*\* · Provide a safe restore procedure\n {2}`README\.md:2`\n {2}Still applies\. Discussion continues on the existing review comment thread\./,
  );
  // Only the newly raised finding gains a root comment.
  assert.equal(plan.inline.length, 1);
  assert.match(plan.inline[0].body, /Do not delete every overlapping ruleset/);

  // The carried finding does not depend on inline placement, so it survives the
  // body GitHub gets when it rejects every inline location.
  assert.match(buildFallbackBody(plan), /Provide a safe restore procedure/);
  assert.match(buildFallbackBody(plan), /\| Major \| 2 \|/);
});

test('an all-settled round lists no findings and keeps its earlier-findings line', () => {
  const plan = buildPublicationPlan({
    outcome: outcome({
      judgement: 'Every earlier finding is resolved.',
      findings: [],
      reconciliation: [
        { category: 'addressed', priorFindingId: 'prior-1' },
        { category: 'declined', priorFindingId: 'prior-2' },
      ],
    }),
    files: [],
    attemptId: 'workflow-settled',
  });
  assert.match(plan.body, /### Changes approved/);
  assert.doesNotMatch(plan.body, /#### Findings/);
  assert.doesNotMatch(plan.body, /\| Severity \| Findings \|/);
  assert.match(
    plan.body,
    /\*\*Earlier findings:\*\* 1 addressed · 1 declined/,
  );
});

test('publishes a regressed finding again so it cannot disappear silently', () => {
  const current = finding({ disposition: 'regressed' });
  const plan = buildPublicationPlan({
    outcome: outcome({
      findings: [current],
      reconciliation: [
        {
          category: 'regressed',
          title: current.title,
          note: 'The issue returned.',
          findingId: current.id,
          priorFindingId: 'prior-1',
        },
      ],
    }),
    files: [{ filename: 'new.ts', patch: PATCH }],
    attemptId: 'workflow-2',
  });
  assert.equal(plan.inline.length, 1);
  assert.match(plan.body, /\*\*Earlier findings:\*\* 1 regressed/);
  assert.match(plan.body, /### Changes requested \(1\)/);
});

test('republishes a regressed composite regardless of constituent order', () => {
  const current = finding({ disposition: 'regressed' });
  const regressed = {
    category: 'regressed',
    title: 'Preserve explicit review requests',
    note: 'This constraint regressed.',
    findingId: current.id,
    priorFindingId: 'prior-1',
  };
  const addressed = {
    category: 'addressed',
    title: 'Serialize automatic reviews',
    note: 'This constraint is satisfied.',
    findingId: current.id,
    priorFindingId: 'prior-2',
  };

  for (const reconciliation of [
    [regressed, addressed],
    [addressed, regressed],
  ]) {
    const plan = buildPublicationPlan({
      outcome: outcome({ findings: [current], reconciliation }),
      files: [{ filename: 'new.ts', patch: PATCH }],
      attemptId: 'workflow-composite-regressed',
    });
    assert.equal(plan.inline.length, 1);
    assert.match(plan.body, /\| Major \| 1 \|/);
    assert.match(
      plan.body,
      /\*\*Earlier findings:\*\* 1 addressed · 1 regressed/,
    );
  }
});

test('preserves finding metadata when an inline location is downgraded', () => {
  const plan = buildPublicationPlan({
    outcome: outcome({ findings: [finding()] }),
    files: [{ filename: 'new.ts', patch: '@@ -10 +10 @@\n-old\n+new' }],
    attemptId: 'workflow-2',
  });
  assert.equal(plan.unplaced[0].title, 'Validate the input');
  assert.equal(plan.unplaced[0].severity, 'major');
});

test('states approval unambiguously when no findings remain', () => {
  const plan = buildPublicationPlan({
    outcome: outcome(),
    files: [],
    attemptId: 'workflow-3',
  });
  assert.match(plan.body, /### Changes approved/);
});

test('requests changes for a first review with active findings', () => {
  const plan = buildPublicationPlan({
    outcome: outcome({ findings: [finding()] }),
    files: [],
    attemptId: 'workflow-4',
  });
  assert.match(plan.body, /### Changes requested \(1\)/);
});

test('counts requested changes for several findings', () => {
  const plan = buildPublicationPlan({
    outcome: outcome({
      findings: [
        finding({ id: 'f-1', location: undefined }),
        finding({ id: 'f-2', severity: 'minor', location: undefined }),
      ],
    }),
    files: [],
    attemptId: 'workflow-4',
  });
  assert.match(plan.body, /### Changes requested \(2\)/);
});

test('the verdict counts findings that require changes rather than all findings', () => {
  const plan = buildPublicationPlan({
    outcome: outcome({
      findings: [
        finding({ id: 'major-1', location: undefined }),
        finding({
          id: 'nit-1',
          severity: 'nit',
          requiresChanges: false,
          location: undefined,
        }),
      ],
    }),
    files: [],
    attemptId: 'workflow-4',
  });
  assert.match(plan.body, /### Changes requested \(1\)/);
  assert.match(plan.body, /\| Major \| 1 \|/);
  assert.match(plan.body, /\| Nit \| 1 \|/);
});

test('renders a deterministic severity table and compact findings list', () => {
  const plan = buildPublicationPlan({
    outcome: outcome({
      judgement: 'Two things need attention.',
      findings: [
        finding({
          id: 'f-major',
          title: 'Report cannot read review findings',
          location: { path: 'new.ts', line: 2, side: 'RIGHT' },
        }),
        finding({
          id: 'f-minor',
          severity: 'minor',
          title: 'Mention matching accepts unintended handles',
          location: { path: 'new.ts', line: 2, side: 'RIGHT' },
        }),
      ],
    }),
    files: [{ filename: 'new.ts', patch: PATCH }],
    attemptId: 'workflow-5',
  });
  assert.match(plan.body, /### Changes requested \(2\)/);
  assert.match(plan.body, /\| Severity \| Findings \|/);
  assert.match(plan.body, /\| Major \| 1 \|/);
  assert.match(plan.body, /\| Minor \| 1 \|/);
  assert.match(plan.body, /#### Findings/);
  assert.match(
    plan.body,
    /- \*\*Major\*\* · Report cannot read review findings\n {2}`new\.ts:2`/,
  );
  assert.match(
    plan.body,
    /- \*\*Minor\*\* · Mention matching accepts unintended handles\n {2}`new\.ts:2`/,
  );
  // Compact summary must not repeat the inline body verbatim.
  assert.doesNotMatch(plan.body, /The value is used before validation\./);
});

test('accounts for earlier findings with only the non-zero categories', () => {
  const plan = buildPublicationPlan({
    outcome: outcome({
      reconciliation: [
        { category: 'addressed', priorFindingId: 'prior-1' },
        { category: 'remaining', priorFindingId: 'prior-2', note: 'x' },
      ],
    }),
    files: [],
    attemptId: 'workflow-6',
  });
  assert.match(plan.body, /\*\*Earlier findings:\*\* 1 addressed · 1 still applies/);
});

test('accounts for a refuted earlier finding alongside an explained one', () => {
  const plan = buildPublicationPlan({
    outcome: outcome({
      reconciliation: [
        { category: 'explained', priorFindingId: 'prior-1' },
        { category: 'refuted', priorFindingId: 'prior-2' },
      ],
    }),
    files: [],
    attemptId: 'workflow-6b',
  });
  assert.match(plan.body, /\*\*Earlier findings:\*\* 1 explained · 1 refuted/);
});

test('a category this Action does not know is counted, never rendered as undefined', () => {
  const plan = buildPublicationPlan({
    outcome: outcome({
      reconciliation: [
        { category: 'addressed', priorFindingId: 'prior-1' },
        // Emitted by a newer CLI than the pinned Action knows about.
        { category: 'superseded', priorFindingId: 'prior-2' },
        // Degenerate: no category at all.
        { priorFindingId: 'prior-3' },
      ],
    }),
    files: [],
    attemptId: 'workflow-6c',
  });
  assert.match(
    plan.body,
    /\*\*Earlier findings:\*\* 1 addressed · 1 superseded · 1 unrecognised/,
  );
  assert.doesNotMatch(plan.body, /undefined/);
  assert.doesNotMatch(buildFallbackBody(plan), /undefined/);
});

test('a category naming an inherited property is treated as unknown', () => {
  const plan = buildPublicationPlan({
    outcome: outcome({
      reconciliation: [{ category: 'constructor', priorFindingId: 'prior-1' }],
    }),
    files: [],
    attemptId: 'workflow-6d',
  });
  assert.match(plan.body, /\*\*Earlier findings:\*\* 1 constructor$/m);
});

test('approves changes while still showing nits', () => {
  const plan = buildPublicationPlan({
    outcome: outcome({
      findings: [
        finding({
          id: 'nit-1',
          severity: 'nit',
          requiresChanges: false,
          title: 'Prefer a const here',
          location: { path: 'new.ts', line: 2, side: 'RIGHT' },
        }),
      ],
    }),
    files: [{ filename: 'new.ts', patch: PATCH }],
    attemptId: 'workflow-7',
  });
  assert.match(plan.body, /### Changes approved/);
  // The nit is still surfaced truthfully rather than silently dropped.
  assert.match(plan.body, /\| Nit \| 1 \|/);
  assert.match(plan.body, /- \*\*Nit\*\* · Prefer a const here/);
});

test('reports approval with earlier findings addressed', () => {
  const plan = buildPublicationPlan({
    outcome: outcome({
      reconciliation: [
        { category: 'addressed', priorFindingId: 'prior-1' },
        { category: 'addressed', priorFindingId: 'prior-2' },
      ],
    }),
    files: [],
    attemptId: 'workflow-8',
  });
  assert.match(plan.body, /### Changes approved/);
  assert.match(plan.body, /\*\*Earlier findings:\*\* 2 addressed/);
});

test('advertises the mention-driven re-review loop in normal and fallback summaries', () => {
  const plan = buildPublicationPlan({
    outcome: outcome({
      findings: [
        finding({ location: { path: 'new.ts', line: 2, side: 'RIGHT' } }),
      ],
    }),
    files: [{ filename: 'new.ts', patch: PATCH }],
    attemptId: 'workflow-8',
  });
  const trigger =
    'Mention `@tessl-code-review` after fixes or replies are ready to run another review.';
  assert.ok(plan.body.includes(trigger));
  assert.ok(buildFallbackBody(plan).includes(trigger));
});

test('compact list uses the correct title when finding.body contains an earlier marker', () => {
  // If finding.body embeds a different canonical marker, index-based pairing
  // must still resolve to the right candidate (not the one whose id appears
  // inside the body text).
  const extraMarker = findingMarker('unrelated-id');
  const plan = buildPublicationPlan({
    outcome: outcome({
      findings: [
        finding({
          id: 'f-real',
          title: 'The real finding title',
          body: `Description that mentions ${extraMarker} an earlier id.`,
          location: { path: 'new.ts', line: 2, side: 'RIGHT' },
        }),
      ],
    }),
    files: [{ filename: 'new.ts', patch: PATCH }],
    attemptId: 'workflow-9',
  });
  assert.equal(plan.inline.length, 1);
  assert.match(plan.body, /The real finding title/);
  assert.doesNotMatch(plan.body, /unrelated-id/);
});

test('an approved outcome still renders visible Minor and Nit findings', () => {
  // Low-impact findings surfaced without blocking: the heading follows
  // outcome.approved, never inferred from severity.
  const plan = buildPublicationPlan({
    outcome: outcome({
      approved: true,
      findings: [
        finding({
          id: 'minor-1',
          severity: 'minor',
          requiresChanges: false,
          title: 'Low-impact polish',
          location: { path: 'new.ts', line: 2, side: 'RIGHT' },
        }),
        finding({
          id: 'nit-1',
          severity: 'nit',
          requiresChanges: false,
          title: 'Prefer a const here',
          location: undefined,
        }),
      ],
    }),
    files: [{ filename: 'new.ts', patch: PATCH }],
    attemptId: 'workflow-10',
  });
  assert.match(plan.body, /### Changes approved/);
  // The non-blocking findings are still displayed.
  assert.match(plan.body, /\| Minor \| 1 \|/);
  assert.match(plan.body, /\| Nit \| 1 \|/);
  assert.match(plan.body, /Low-impact polish/);
});

test('a changes-requested heading counts only findings that require changes', () => {
  const plan = buildPublicationPlan({
    outcome: outcome({
      approved: false,
      findings: [
        finding({
          id: 'major-1',
          severity: 'major',
          requiresChanges: true,
          location: undefined,
        }),
        finding({
          id: 'nit-1',
          severity: 'nit',
          requiresChanges: false,
          location: undefined,
        }),
      ],
    }),
    files: [],
    attemptId: 'workflow-11',
  });
  // Only the major that requires changes counts toward the heading; the nit is
  // still shown in the table.
  assert.match(plan.body, /### Changes requested \(1\)/);
  assert.match(plan.body, /\| Nit \| 1 \|/);
});

test('the fallback body uses the same approval heading', () => {
  const plan = buildPublicationPlan({
    outcome: outcome({
      approved: true,
      findings: [
        finding({
          id: 'nit-1',
          severity: 'nit',
          requiresChanges: false,
          location: { path: 'new.ts', line: 2, side: 'RIGHT' },
        }),
      ],
    }),
    files: [{ filename: 'new.ts', patch: PATCH }],
    attemptId: 'workflow-12',
  });
  assert.match(buildFallbackBody(plan), /### Changes approved/);
});

test('replies only after user activity and does not repeat the same disposition', () => {
  const marker = findingMarker('prior-1');
  const reconciliation = [
    {
      category: 'explained',
      title: 'Validate input',
      note: 'The caller guarantees this invariant.',
      priorFindingId: 'prior-1',
    },
  ];
  const root = {
    id: 10,
    body: `finding body ${marker}`,
    user: { login: 'github-actions[bot]', type: 'Bot' },
  };
  assert.deepEqual(
    planConversationReplies({
      reconciliation,
      findings: [],
      reviewComments: [root],
    }),
    [],
  );

  const userReply = {
    id: 11,
    in_reply_to_id: 10,
    body: 'This is intentional because the caller validates it.',
    user: { login: 'developer', type: 'User' },
  };
  const replies = planConversationReplies({
    reconciliation,
    findings: [],
    reviewComments: [root, userReply],
  });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].rootCommentId, 10);
  assert.match(replies[0].body, /Not repeated: explained/);

  const botReply = {
    id: 12,
    in_reply_to_id: 10,
    body: replies[0].body,
    user: { login: 'github-actions[bot]', type: 'Bot' },
  };
  assert.deepEqual(
    planConversationReplies({
      reconciliation,
      findings: [],
      reviewComments: [root, userReply, botReply],
    }),
    [],
  );
});

test('a repeated still-applies disposition answers a new fix claim', () => {
  const marker = findingMarker('prior-1');
  const current = finding({
    id: 'finding-carried',
    disposition: 'remaining',
    body: 'The restore procedure can still write after a failed lookup.',
  });
  const reconciliation = [
    {
      category: 'remaining',
      note: 'The issue is still present.',
      findingId: current.id,
      priorFindingId: 'prior-1',
    },
  ];
  const thread = [
    {
      id: 50,
      body: `finding body ${marker}`,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    },
    {
      id: 51,
      in_reply_to_id: 50,
      body: 'Fixed in a8dbcc5.',
      user: { login: 'developer', type: 'User' },
    },
  ];

  const first = planConversationReplies({
    reconciliation,
    findings: [current],
    reviewComments: thread,
  });
  assert.equal(first.length, 1);
  assert.match(first[0].body, /Still applies after re-review\./);

  const answered = [
    ...thread,
    {
      id: 52,
      in_reply_to_id: 50,
      body: first[0].body,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    },
  ];
  // Nothing new has been said, so the thread is left alone.
  assert.deepEqual(
    planConversationReplies({
      reconciliation,
      findings: [current],
      reviewComments: answered,
    }),
    [],
  );

  // The author claims a fix that this round still finds unresolved. Without a
  // reply, that claim would stand as the thread's last word.
  const second = planConversationReplies({
    reconciliation,
    findings: [current],
    reviewComments: [
      ...answered,
      {
        id: 53,
        in_reply_to_id: 50,
        body: 'Fixed in 7d734df.',
        user: { login: 'developer', type: 'User' },
      },
    ],
  });
  assert.equal(second.length, 1);
  assert.equal(second[0].rootCommentId, 50);
  assert.match(second[0].body, /Still applies after re-review\./);
  assert.match(second[0].body, /can still write after a failed lookup/);
});

test('a third-party bot on the thread does not silence the reconciliation reply', () => {
  const marker = findingMarker('prior-1');
  const reconciliation = [
    {
      category: 'explained',
      note: 'The caller guarantees this invariant.',
      priorFindingId: 'prior-1',
    },
  ];
  const thread = [
    {
      id: 60,
      body: `finding body ${marker}`,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    },
    {
      id: 61,
      in_reply_to_id: 60,
      body: 'This is intentional.',
      user: { login: 'developer', type: 'User' },
    },
    {
      id: 62,
      in_reply_to_id: 60,
      body: 'Consider extracting a helper here.',
      user: { login: 'example-review-bot[bot]', type: 'Bot' },
    },
  ];

  const replies = planConversationReplies({
    reconciliation,
    findings: [],
    reviewComments: thread,
  });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].rootCommentId, 60);

  // This Action's own reply is the last word, so the round is answered.
  const answered = [
    ...thread,
    {
      id: 63,
      in_reply_to_id: 60,
      body: replies[0].body,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    },
  ];
  assert.deepEqual(
    planConversationReplies({
      reconciliation,
      findings: [],
      reviewComments: answered,
    }),
    [],
  );

  // A third-party bot speaking after that answer is new activity.
  const followed = planConversationReplies({
    reconciliation,
    findings: [],
    reviewComments: [
      ...answered,
      {
        id: 64,
        in_reply_to_id: 60,
        body: 'One more suggestion.',
        user: { login: 'another-bot[bot]', type: 'Bot' },
      },
    ],
  });
  assert.equal(followed.length, 1);
});

test('an author quoting a reply is answered rather than read as this Action', () => {
  const marker = findingMarker('prior-1');
  const reconciliation = [
    {
      category: 'explained',
      note: 'The caller guarantees this invariant.',
      priorFindingId: 'prior-1',
    },
  ];
  const thread = [
    {
      id: 70,
      body: `finding body ${marker}`,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    },
    {
      id: 71,
      in_reply_to_id: 70,
      body: 'This is intentional.',
      user: { login: 'developer', type: 'User' },
    },
  ];

  const replies = planConversationReplies({
    reconciliation,
    findings: [],
    reviewComments: thread,
  });
  assert.equal(replies.length, 1);

  // GitHub's quote reply copies the quoted markdown, marker included, behind a
  // `> ` prefix. The quoting comment is the author speaking, not this Action.
  const quoted = planConversationReplies({
    reconciliation,
    findings: [],
    reviewComments: [
      ...thread,
      {
        id: 72,
        in_reply_to_id: 70,
        body: replies[0].body,
        user: { login: 'github-actions[bot]', type: 'Bot' },
      },
      {
        id: 73,
        in_reply_to_id: 70,
        body: `${replies[0].body.replace(/^/gm, '> ')}\n\nStill not convinced.`,
        user: { login: 'developer', type: 'User' },
      },
    ],
  });
  assert.equal(quoted.length, 1);
  assert.equal(quoted[0].rootCommentId, 70);
});

// The reconciliation marker identifies this Action's own reply, so the login it
// was posted under does not matter. The login below is an arbitrary one.
test('an answered round stays answered when this Action posts under any identity', () => {
  const marker = findingMarker('prior-1');
  const replies = planConversationReplies({
    reconciliation: [
      { category: 'refuted', note: 'Unreachable.', priorFindingId: 'prior-1' },
    ],
    findings: [],
    reviewComments: [
      {
        id: 70,
        body: `finding body ${marker}`,
        user: { login: 'github-actions[bot]', type: 'Bot' },
      },
      {
        id: 71,
        in_reply_to_id: 70,
        body: 'That path is unreachable.',
        user: { login: 'developer', type: 'User' },
      },
      {
        id: 72,
        in_reply_to_id: 70,
        body: `Not repeated: refuted in the conversation.\n\n${reconciliationMarker('prior-1', 'refuted')}`,
        user: { login: 'tessl-code-review[bot]', type: 'Bot' },
      },
    ],
  });
  assert.deepEqual(replies, []);
});

test('a refuted entry gets its own thread reply', () => {
  const marker = findingMarker('prior-1');
  const replies = planConversationReplies({
    reconciliation: [
      {
        category: 'refuted',
        note: 'The cited call cannot receive that value.',
        priorFindingId: 'prior-1',
      },
    ],
    findings: [],
    reviewComments: [
      {
        id: 30,
        body: `finding body ${marker}`,
        user: { login: 'github-actions[bot]', type: 'Bot' },
      },
      {
        id: 31,
        in_reply_to_id: 30,
        body: 'That path is unreachable.',
        user: { login: 'developer', type: 'User' },
      },
    ],
  });
  assert.equal(replies.length, 1);
  assert.match(replies[0].body, /Not repeated: refuted in the conversation\./);
  assert.match(replies[0].body, /The cited call cannot receive that value\./);
});

test('a reply for an unknown category stays neutral rather than posting undefined', () => {
  const marker = findingMarker('prior-1');
  const reviewComments = [
    {
      id: 40,
      body: `finding body ${marker}`,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    },
    {
      id: 41,
      in_reply_to_id: 40,
      body: 'Handled elsewhere.',
      user: { login: 'developer', type: 'User' },
    },
  ];
  const reply = (category) =>
    planConversationReplies({
      reconciliation: [
        { category, note: 'See the linked change.', priorFindingId: 'prior-1' },
      ],
      // The finding body must not leak into a category we cannot classify as
      // surfaced; only the entry's own note is used.
      findings: [finding({ id: 'finding-1', body: 'Still unhandled.' })],
      reviewComments,
    })[0];

  const unknown = reply('superseded');
  assert.match(unknown.body, /Reconciled in the current revision as `superseded`\./);
  assert.match(unknown.body, /See the linked change\./);
  assert.doesNotMatch(unknown.body, /undefined/);
  assert.doesNotMatch(unknown.body, /Still unhandled\./);

  // Nothing usable at all still yields a sentence.
  const missing = reply(undefined);
  assert.match(missing.body, /Reconciled in the current revision as `unrecognised`\./);
  assert.doesNotMatch(missing.body, /undefined/);
});

test('a settled composite constituent reply uses its own reconciliation note', () => {
  const marker = findingMarker('prior-1');
  const current = finding({
    id: 'composite-1',
    disposition: 'remaining',
    body: 'The combined invariant still does not hold.',
  });
  const reconciliation = [
    {
      category: 'addressed',
      title: 'Serialize automatic reviews',
      note: 'This constituent is satisfied by the current code.',
      findingId: current.id,
      priorFindingId: 'prior-1',
    },
  ];
  const reviewComments = [
    {
      id: 20,
      body: `finding body ${marker}`,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    },
    {
      id: 21,
      in_reply_to_id: 20,
      body: 'Fixed in the latest commit.',
      user: { login: 'developer', type: 'User' },
    },
  ];

  const replies = planConversationReplies({
    reconciliation,
    findings: [current],
    reviewComments,
  });
  assert.equal(replies.length, 1);
  assert.match(replies[0].body, /Addressed in the current revision/);
  assert.match(replies[0].body, /This constituent is satisfied/);
  assert.doesNotMatch(replies[0].body, /combined invariant still does not hold/);
});
