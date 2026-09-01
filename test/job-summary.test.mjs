import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { reviewJobSummary, writeJobSummary } from '../src/job-summary.mjs';

const HEAD_SHA = '714940a07292da93003f8696604a28ababd844bb';
const runUrl = 'https://github.example/run/1';

function result(overrides = {}) {
  return {
    outcome: {
      approved: false,
      judgement: 'The workflow misroutes inline review-comment requests.',
      lenses: [
        { ref: 'tessl/code-review@0.1.0#review-security-and-privacy' },
        { ref: './review-lenses/review-heavy-invariants/SKILL.md' },
      ],
      subject: { change: { headRevision: HEAD_SHA } },
      findings: [
        {
          severity: 'minor',
          title: 'Test placement guidance',
          requiresChanges: false,
          path: 'skills/write-a-test/SKILL.md',
          line: 10,
        },
        {
          severity: 'critical',
          title: 'Fork-controlled review instructions',
          requiresChanges: true,
          path: '.github/workflows/tessl-code-review.yml',
          line: 67,
        },
        {
          severity: 'major',
          title: 'Inline comments have no pull-request identifier',
          requiresChanges: true,
          location: {
            path: '.github/workflows/tessl-code-review.yml',
            line: 31,
          },
        },
      ],
    },
    diagnostics: { durationMs: 130309 },
    publication: {
      status: 'published',
      reviewId: 5053785079,
      inlineCount: 8,
    },
    ...overrides,
  };
}

function summaryFor(overrides = {}, options = {}) {
  return reviewJobSummary({
    result: result(overrides),
    mode: 'advisory',
    status: 'advisory-findings',
    runUrl,
    repository: 'Kacper-Lubisz/heavy',
    prNumber: '4',
    ...options,
  });
}

test('a reviewed run renders the verdict, the judgement and both finding groups', () => {
  const summary = summaryFor();

  assert.match(summary, /^## Tessl Code Review$/mu);
  assert.match(summary, /^### Changes requested \(2\)$/mu);
  assert.match(summary, /The workflow misroutes inline review-comment requests\./u);
  assert.match(summary, /^#### Must fix$/mu);
  assert.match(summary, /^#### Suggestions \(1\)$/mu);
  // Grouped by requiresChanges, not by severity: the minor suggestion must not
  // appear above the major finding that blocks.
  assert.ok(summary.indexOf('#### Must fix') < summary.indexOf('#### Suggestions'));
  assert.ok(
    summary.indexOf('Inline comments have no pull-request identifier') <
      summary.indexOf('Test placement guidance'),
  );
});

test('the severity table is ordered by rank rather than by finding order', () => {
  const summary = summaryFor();
  const rows = summary
    .split('\n')
    .filter((line) => /^\| (Critical|Major|Minor|Nit) \|/u.test(line));

  assert.deepEqual(rows, ['| Critical | 1 |', '| Major | 1 |', '| Minor | 1 |']);
});

test('a finding location is read from either the flat or the nested form', () => {
  const summary = summaryFor();

  assert.match(summary, /`\.github\/workflows\/tessl-code-review\.yml:67`/u);
  assert.match(summary, /`\.github\/workflows\/tessl-code-review\.yml:31`/u);
});

test('the context line carries the mode, lens count, duration and reviewed head — and never a cost', () => {
  const summary = summaryFor();

  assert.match(summary, /advisory · 2 lenses · 2m 10s · `714940a`/u);
  assert.ok(!summary.includes('$'), 'the summary must not contain a cost');
  assert.doesNotMatch(summary, /cost/iu);
});

test('lenses are named the way the published review names them', () => {
  const summary = summaryFor();

  assert.match(summary, /^Lenses: Security And Privacy · Heavy Invariants$/mu);
});

test('a published review is linked, addressed by its review id', () => {
  const summary = summaryFor();

  assert.match(
    summary,
    /\[View the published review\]\(https:\/\/github\.com\/Kacper-Lubisz\/heavy\/pull\/4#pullrequestreview-5053785079\)/u,
  );
});

test('nothing is linked when the review was never published', () => {
  const summary = summaryFor({ publication: { status: 'superseded' } });

  assert.doesNotMatch(summary, /View the published review/u);
});

test('a malformed repository or pull-request number drops the link rather than building a wrong one', () => {
  for (const options of [
    { repository: 'not a repository' },
    { prNumber: '0' },
    { prNumber: '' },
  ]) {
    assert.doesNotMatch(summaryFor({}, options), /View the published review/u);
  }
});

test('an approving review with suggestions says nothing is blocking', () => {
  const summary = summaryFor({
    outcome: {
      ...result().outcome,
      approved: true,
      findings: [
        {
          severity: 'nit',
          title: 'Spelling',
          requiresChanges: false,
          path: 'a.md',
          line: 1,
        },
      ],
    },
  });

  assert.match(summary, /^### Changes approved$/mu);
  assert.match(summary, /^1 optional suggestion\. Nothing blocking\.$/mu);
  assert.doesNotMatch(summary, /#### Must fix/u);
});

test('earlier findings are summarised the way the published review summarises them', () => {
  const summary = summaryFor({
    outcome: {
      ...result().outcome,
      reconciliation: [
        { category: 'remaining' },
        { category: 'remaining' },
        { category: 'addressed' },
        { category: 'not-a-category' },
      ],
    },
  });

  assert.match(summary, /\*\*Earlier findings:\*\* 2 still apply · 1 addressed/u);
});

test('a completed review whose publication failed is still rendered, with the status under it', () => {
  const summary = summaryFor({}, { status: 'publication-failure' });

  assert.match(summary, /^### Changes requested \(2\)$/mu);
  assert.match(summary, /> Tessl Code Review completed but could not publish/u);
  assert.match(summary, /\[View the workflow run\]\(https:\/\/github\.example\/run\/1\)/u);
});

test('a run with no outcome renders the status the check run reports, and the CLI reason', () => {
  const summary = reviewJobSummary({
    result: { status: 'failed' },
    mode: 'gate',
    status: 'technical-failure',
    reason: 'Lens ref "./review-lenses/gone/SKILL.md" does not resolve.',
    runUrl,
  });

  assert.match(summary, /^### Review did not complete$/mu);
  assert.match(summary, /The Tessl CLI reported: `Lens ref .* does not resolve\.`/u);
  assert.match(summary, /\[View the workflow run\]/u);
  assert.doesNotMatch(summary, /#### Must fix/u);
});

test('a run refused for no matching lenses says exactly that', () => {
  const summary = reviewJobSummary({
    result: { status: 'skipped', reason: 'no-matching-lenses' },
    mode: 'advisory',
    status: 'skipped-no-matching-lenses',
    runUrl,
  });

  assert.match(summary, /^### No matching review lenses$/mu);
});

test('model-authored text cannot break out of the line it is rendered on', () => {
  const summary = summaryFor({
    outcome: {
      ...result().outcome,
      findings: [
        {
          severity: 'major',
          title: 'First line\n## Injected heading',
          requiresChanges: true,
          path: 'a.ts',
          line: 2,
        },
      ],
    },
  });

  assert.match(summary, /- \*\*Major\*\* · First line ## Injected heading/u);
  assert.doesNotMatch(summary, /^## Injected heading$/mu);
});

test('a long judgement and a long title are truncated rather than dropped', () => {
  const summary = summaryFor({
    outcome: {
      ...result().outcome,
      judgement: 'j'.repeat(5000),
      findings: [
        {
          severity: 'minor',
          title: 't'.repeat(500),
          requiresChanges: false,
          path: 'a.ts',
          line: 1,
        },
      ],
    },
  });

  assert.match(summary, /j{4000}…/u);
  assert.match(summary, /t{300}…/u);
});

test('a review longer than the listed limit reports how many it did not list', () => {
  const findings = Array.from({ length: 60 }, (_unused, index) => ({
    severity: 'minor',
    title: `Finding ${index}`,
    requiresChanges: false,
    path: 'a.ts',
    line: index + 1,
  }));
  const summary = summaryFor({
    outcome: { ...result().outcome, approved: true, findings },
  });

  assert.match(summary, /^- _and 10 more\._$/mu);
});

test('the summary is written to the job-summary file, and a missing path is not an error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tessl-job-summary-'));
  const summaryPath = join(directory, 'summary.md');

  const written = await writeJobSummary({
    summaryPath,
    result: result(),
    mode: 'advisory',
    status: 'advisory-findings',
    runUrl,
    repository: 'Kacper-Lubisz/heavy',
    prNumber: '4',
  });

  assert.equal(written, true);
  assert.match(await readFile(summaryPath, 'utf8'), /## Tessl Code Review/u);
  assert.equal(await writeJobSummary({ summaryPath: '' }), false);
  assert.equal(await writeJobSummary({}), false);
});

test('a write failure is a notice, not a throw', async () => {
  const lines = [];

  const written = await writeJobSummary({
    summaryPath: join(tmpdir(), 'tessl-job-summary-missing', 'nope', 'x.md'),
    result: result(),
    mode: 'advisory',
    status: 'advisory-findings',
    log: { log: (line) => lines.push(line) },
  });

  assert.equal(written, false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^::notice::The review could not be written/u);
});

/* ── Review feedback on PR #31: two Major findings, both addressed here ──── */

test('every outcome-bearing status that does not establish a verdict explains itself', () => {
  for (const status of [
    'publication-failure',
    'gate-configuration-failure',
    'superseded',
    'gate-verdict-failure',
    'incompatible-cli',
    'a-status-this-revision-has-never-heard-of',
  ]) {
    const summary = summaryFor({}, { mode: 'gate', status });

    assert.match(summary, /^### Changes requested \(2\)$/mu, status);
    assert.match(summary, /^> /mu, `${status} must quote the check's own explanation`);
    assert.match(summary, /\[View the workflow run\]/u, status);
  }
});

test('a status whose verdict stands carries no explanation block', () => {
  for (const [mode, status] of [
    ['advisory', 'advisory-findings'],
    ['gate', 'changes-requested'],
    ['gate', 'approved'],
  ]) {
    assert.doesNotMatch(summaryFor({}, { mode, status }), /^> /mu, status);
  }
});

test('the reviewed revision is never taken from the head the Action resolved', () => {
  const withoutRevision = result();
  delete withoutRevision.outcome.subject;

  const summary = reviewJobSummary({
    result: withoutRevision,
    mode: 'gate',
    status: 'incompatible-cli',
    headSha: HEAD_SHA,
    runUrl,
  });

  assert.doesNotMatch(summary, /714940a/u);
  assert.match(summary, /^> /mu);
});

test('a judgement cannot open a heading, a list or a link', () => {
  const summary = summaryFor({
    outcome: {
      ...result().outcome,
      judgement:
        '## Changes approved\n\n- injected item\n\n1. injected step\n\n[click](https://evil.example) <img src=x>',
    },
  });

  assert.doesNotMatch(summary, /^## Changes approved$/mu);
  assert.doesNotMatch(summary, /^- injected item$/mu);
  assert.doesNotMatch(summary, /^1\. injected step$/mu);
  assert.doesNotMatch(summary, /\[click\]\(https:\/\/evil\.example\)/u);
  // Escaped, so it renders as text: `\<img` is literal, `<img` would be markup.
  assert.doesNotMatch(summary, /(?<!\\)<img/u);
  assert.match(summary, /\\<img src=x\\>/u);
  // The words survive; only their power does.
  assert.match(summary, /injected item/u);
});

test('a finding title cannot emphasise, link or open raw HTML', () => {
  const summary = summaryFor({
    outcome: {
      ...result().outcome,
      findings: [
        {
          severity: 'major',
          title: '**bold** [link](https://evil.example) `code` <b>html</b> | cell',
          requiresChanges: true,
          path: 'a.ts',
          line: 1,
        },
      ],
    },
  });

  assert.doesNotMatch(summary, /\*\*bold\*\*/u);
  assert.doesNotMatch(summary, /\[link\]\(/u);
  assert.doesNotMatch(summary, /(?<!\\)<b>/u);
  assert.match(summary, /bold/u);
});

test('bidirectional overrides and invisible formatting characters are stripped', () => {
  const summary = summaryFor({
    outcome: {
      ...result().outcome,
      judgement: 'safe\u202Eevlas\u202C text',
      findings: [
        {
          severity: 'major',
          title: 'title\u200B\u2066spoofed\u2069',
          requiresChanges: true,
          path: 'a\u202E.ts',
          line: 1,
        },
      ],
    },
  });

  for (const character of ['\u202E', '\u202C', '\u200B', '\u2066', '\u2069']) {
    assert.ok(!summary.includes(character), `stripped ${escape(character)}`);
  }
});

test('a backtick in a path cannot close the code span that holds it', () => {
  const summary = summaryFor({
    outcome: {
      ...result().outcome,
      findings: [
        {
          severity: 'major',
          title: 'Odd path',
          requiresChanges: true,
          path: 'a`.ts`',
          line: 1,
        },
      ],
    },
  });

  assert.match(summary, /`a\.ts:1`/u);
});
