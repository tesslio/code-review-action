#!/usr/bin/env node

/**
 * Render every job-summary state into the run's own job summary.
 *
 * The summary is a rendering, and a rendering is reviewed by looking at it. Unit
 * tests assert that particular strings appear; they cannot tell a reader whether
 * the result reads well, whether a table lines up, or whether a failure state
 * says something useful. This puts the actual output on the run page of every
 * pull request that touches the renderer, so the thing under review is visible
 * in the place a reviewer already is.
 *
 * Deterministic and free: it renders fixtures, makes no network call, spends no
 * model credit, and publishes nothing to a pull request. Writes to stdout when
 * `GITHUB_STEP_SUMMARY` is unset, so it is also the local way to see the output.
 */

import { appendFile } from 'node:fs/promises';

import { reviewJobSummary } from '../src/job-summary.mjs';

const HEAD = '714940a07292da93003f8696604a28ababd844bb';

const findings = [
  {
    severity: 'major',
    title: 'Inline review comments have no pull-request identifier',
    requiresChanges: true,
    path: '.github/workflows/tessl-code-review.yml',
    line: 31,
  },
  {
    severity: 'critical',
    title:
      'Privileged comment-triggered runs consume fork-controlled review instructions',
    requiresChanges: true,
    path: '.github/workflows/tessl-code-review.yml',
    line: 67,
  },
  {
    severity: 'minor',
    title: 'Test-placement guidance points to files Vitest does not collect',
    requiresChanges: false,
    path: '.claude/skills/write-a-test/SKILL.md',
    line: 10,
  },
  {
    severity: 'nit',
    title: 'Prisma guidance names a schema path that is not valid from the root',
    requiresChanges: false,
    path: '.claude/skills/prisma-stuff/SKILL.md',
    line: 15,
  },
];

const reviewed = {
  outcome: {
    approved: false,
    judgement:
      'The workflow still misroutes inline review-comment requests and allows a secret-bearing review of fork head-controlled instructions.\n\nThe repository guidance also conflicts with the configured test layout and two stated invariants.',
    lenses: [
      { ref: 'tessl/code-review@0.1.0#review-correctness-and-data-integrity' },
      { ref: 'tessl/code-review@0.1.0#review-security-and-privacy' },
    ],
    subject: { change: { headRevision: HEAD } },
    findings,
    reconciliation: [
      { category: 'remaining' },
      { category: 'remaining' },
      { category: 'addressed' },
    ],
  },
  diagnostics: { durationMs: 130_309 },
  publication: { status: 'published', reviewId: 5_053_785_079, inlineCount: 8 },
};

const approved = {
  ...reviewed,
  outcome: {
    ...reviewed.outcome,
    approved: true,
    judgement: 'A couple of small things, nothing blocking.',
    findings: findings.filter((finding) => !finding.requiresChanges),
    reconciliation: [],
  },
};

/** A judgement carrying everything a model should not be able to do to a page. */
const hostile = {
  ...reviewed,
  outcome: {
    ...reviewed.outcome,
    judgement:
      '## Changes approved\n\n- injected list item\n\n[click](https://evil.example) <img src=x>\n\nText with a\rcarriage return.',
    findings: [
      {
        severity: 'major | 999 | <img src=x>',
        title: '**bold** [link](https://evil.example) `code` <b>html</b>',
        requiresChanges: true,
        path: 'dir/a\tb  c.ts',
        line: 3,
      },
    ],
  },
};

const STATES = [
  {
    title: 'Changes requested, round 2, published',
    note: 'The ordinary case. Severity table ordered worst-first, one flat findings list in outcome order, the earlier-findings reconciliation, and a link to the published review.',
    input: {
      result: reviewed,
      mode: 'advisory',
      status: 'advisory-findings',
      runUrl: 'https://github.example/run/1',
      repository: 'Kacper-Lubisz/heavy',
      prNumber: '4',
    },
  },
  {
    title: 'Approved, with suggestions',
    note: 'The optional-suggestion line is what stops an approving review that lists findings from reading as a contradiction.',
    input: {
      result: approved,
      mode: 'gate',
      status: 'approved',
      repository: 'Kacper-Lubisz/heavy',
      prNumber: '4',
    },
  },
  {
    title: 'Review completed, publication failed',
    note: 'The case that justifies this surface: the review is readable nowhere else, and the check run status is quoted beneath it so it is not mistaken for a published verdict.',
    input: {
      result: reviewed,
      mode: 'gate',
      status: 'publication-failure',
      runUrl: 'https://github.example/run/1',
      repository: 'Kacper-Lubisz/heavy',
      prNumber: '4',
    },
  },
  {
    title: 'Gate mode, no boolean verdict',
    note: 'An outcome exists but establishes no verdict for the head under check, so the review renders with the check run explaining itself. Fails closed.',
    input: {
      result: reviewed,
      mode: 'gate',
      status: 'gate-verdict-failure',
      runUrl: 'https://github.example/run/1',
    },
  },
  {
    title: 'No outcome at all',
    note: 'The CLI never produced a review. The status sentence comes from checkRunReport, so the summary and the check cannot disagree.',
    input: {
      result: { status: 'failed' },
      mode: 'gate',
      status: 'technical-failure',
      reason: 'Lens ref "./review-lenses/gone/SKILL.md" does not resolve.',
      runUrl: 'https://github.example/run/1',
    },
  },
  {
    title: 'Hostile model output',
    note: 'Every value here is trying to escape its context: an injected heading, a list, a link, an image, raw HTML, a pipe in a severity, a carriage return, and a path with a tab. Nothing below should render as structure, and the path should read exactly as reported.',
    input: {
      result: hostile,
      mode: 'advisory',
      status: 'advisory-findings',
      runUrl: 'https://github.example/run/1',
    },
  },
];

const sections = STATES.flatMap(({ title, note, input }) => [
  `## ${title}`,
  '',
  `_${note}_`,
  '',
  '<blockquote>',
  '',
  reviewJobSummary(input).trimEnd(),
  '',
  '</blockquote>',
  '',
  '<details><summary>the same, as raw Markdown</summary>',
  '',
  '```markdown',
  reviewJobSummary(input).trimEnd(),
  '```',
  '',
  '</details>',
  '',
]);

const document = [
  '# Job summary — every state, rendered',
  '',
  'Fixtures, not a live review: deterministic, no network, no model spend, nothing published.',
  'Each state is shown as it renders, and again as the raw Markdown it produces.',
  '',
  ...sections,
].join('\n');

const target = process.env.GITHUB_STEP_SUMMARY;
if (target === undefined || target === '') {
  process.stdout.write(`${document}\n`);
} else {
  await appendFile(target, `${document}\n`, 'utf8');
}
