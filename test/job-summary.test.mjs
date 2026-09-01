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

test('a reviewed run renders the verdict, the judgement and one flat findings list', () => {
  const summary = summaryFor();

  assert.match(summary, /^## Tessl Code Review$/mu);
  assert.match(summary, /^### Changes requested \(2\)$/mu);
  assert.match(summary, /The workflow misroutes inline review-comment requests\./u);
  assert.match(summary, /^#### Findings$/mu);
});

test('the markdown design does not group findings — that is the CLI design alone', () => {
  const summary = summaryFor();

  assert.doesNotMatch(summary, /Must fix/iu);
  assert.doesNotMatch(summary, /Suggestions/iu);
  // Findings keep the outcome's own order, as the published body lists them.
  assert.ok(
    summary.indexOf('Test placement guidance') <
      summary.indexOf('Fork-controlled review instructions'),
    'the flat list follows outcome order, not severity',
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

test('no run chips, no lens footer — the body carries neither, so nor does this', () => {
  const summary = summaryFor();

  assert.doesNotMatch(summary, /advisory/u);
  assert.doesNotMatch(summary, /714940a/u);
  assert.doesNotMatch(summary, /^Lenses:/mu);
  assert.doesNotMatch(summary, /2m 10s/u);
});

test('no cost, anywhere', () => {
  const summary = summaryFor();

  assert.ok(!summary.includes('$'), 'the summary must not contain a cost');
  assert.doesNotMatch(summary, /cost/iu);
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
  assert.match(summary, /^#### Findings$/mu);
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
  assert.doesNotMatch(summary, /#### Findings/u);
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
  const lines = [];

  const written = await writeJobSummary({
    summaryPath,
    log: { log: (line) => lines.push(line) },
    result: result(),
    mode: 'advisory',
    status: 'advisory-findings',
    runUrl,
    repository: 'Kacper-Lubisz/heavy',
    prNumber: '4',
  });

  assert.equal(written, true);
  assert.match(await readFile(summaryPath, 'utf8'), /## Tessl Code Review/u);
  assert.equal(lines.length, 1, 'a successful write reports itself once');
  assert.match(lines[0], /^::notice::Wrote \d+ characters of review to the job summary/u);
  // An absent path reports itself rather than passing silently.
  const quiet = [];
  const logger = { log: (line) => quiet.push(line) };
  assert.equal(await writeJobSummary({ summaryPath: '', log: logger }), false);
  assert.equal(await writeJobSummary({ log: logger }), false);
  assert.equal(quiet.length, 2);
  for (const line of quiet) {
    assert.match(line, /^::notice::The review was not written to the job summary/u);
  }
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

test('the cap never hides a blocking finding, whatever the outcome order', () => {
  const findings = [
    ...Array.from({ length: 50 }, (_unused, index) => ({
      severity: 'minor',
      title: `Optional ${index}`,
      requiresChanges: false,
      path: 'a.ts',
      line: index + 1,
    })),
    {
      severity: 'critical',
      title: 'The one that blocks',
      requiresChanges: true,
      path: 'blocking.ts',
      line: 7,
    },
  ];
  const summary = summaryFor({ outcome: { ...result().outcome, findings } });

  assert.match(summary, /^### Changes requested \(1\)$/mu);
  // The finding that caused the verdict is listed, with its location.
  assert.match(summary, /The one that blocks/u);
  assert.match(summary, /`blocking\.ts:7`/u);
  assert.match(summary, /^- _and 1 more\._$/mu);
});

test('the selected findings still render in the outcome order', () => {
  const findings = [
    { severity: 'minor', title: 'First optional', requiresChanges: false, path: 'a.ts', line: 1 },
    { severity: 'critical', title: 'Blocking one', requiresChanges: true, path: 'b.ts', line: 2 },
    ...Array.from({ length: 60 }, (_unused, index) => ({
      severity: 'nit',
      title: `Filler ${index}`,
      requiresChanges: false,
      path: 'c.ts',
      line: index + 1,
    })),
  ];
  const summary = summaryFor({ outcome: { ...result().outcome, findings } });

  assert.ok(
    summary.indexOf('First optional') < summary.indexOf('Blocking one'),
    'outcome order is preserved among the findings that are rendered',
  );
});

test('more blocking findings than the cap are capped too, and counted', () => {
  const findings = Array.from({ length: 60 }, (_unused, index) => ({
    severity: 'major',
    title: `Blocking ${index}`,
    requiresChanges: true,
    path: 'a.ts',
    line: index + 1,
  }));
  const summary = summaryFor({ outcome: { ...result().outcome, findings } });

  assert.match(summary, /^### Changes requested \(60\)$/mu);
  assert.match(summary, /^- _and 10 more\._$/mu);
});

test('an untrusted severity cannot open a table column or break out of its label', () => {
  const summary = summaryFor({
    outcome: {
      ...result().outcome,
      findings: [
        {
          severity: 'major | 999 | <img src=x>',
          title: 'A finding',
          requiresChanges: true,
          path: 'a.ts',
          line: 1,
        },
        {
          severity: '**bold**',
          title: 'Another finding',
          requiresChanges: false,
          path: 'b.ts',
          line: 2,
        },
      ],
    },
  });

  // No unescaped pipe reaches a table row beyond the two the row itself has.
  for (const row of summary.split('\n').filter((line) => line.startsWith('| '))) {
    const unescaped = row.replace(/\\\|/gu, '');
    assert.ok(
      unescaped.split('|').length <= 4,
      `a severity opened a table column: ${row}`,
    );
  }
  assert.doesNotMatch(summary, /(?<!\\)<img/u);
  assert.doesNotMatch(summary, /\*\*bold\*\*/u);
  // The value still reads, capitalised, with its power removed.
  assert.match(summary, /Major/u);
});

test('no line ending in any model-authored value can start a new line', () => {
  // A lone carriage return, and the Unicode line and paragraph separators, all
  // end a line for a Markdown renderer and all survive control stripping.
  for (const ending of ['\r', '\u2028', '\u2029', '\r\n']) {
    const summary = summaryFor({
      outcome: {
        ...result().outcome,
        judgement: `Looks fine.${ending}## Changes approved`,
        findings: [
          {
            severity: `major${ending}# Injected`,
            title: `A finding${ending}## Also injected`,
            requiresChanges: true,
            path: `a.ts${ending}## Path injected`,
            line: 1,
          },
        ],
      },
    });

    assert.doesNotMatch(summary, /^## Changes approved$/mu, JSON.stringify(ending));
    assert.doesNotMatch(summary, /^# Injected$/mu, JSON.stringify(ending));
    assert.doesNotMatch(summary, /^## Also injected$/mu, JSON.stringify(ending));
    assert.doesNotMatch(summary, /^## Path injected$/mu, JSON.stringify(ending));
    // The severity table keeps exactly one row per severity.
    const rows = summary.split('\n').filter((line) => line.startsWith('| '));
    assert.equal(rows.length, 3, `header, divider and one row for ${JSON.stringify(ending)}`);
  }
});

test('a value ending in whitespace cannot leave a trailing-space line break', () => {
  const summary = summaryFor({
    outcome: {
      ...result().outcome,
      findings: [
        {
          severity: 'major',
          title: 'Trailing   ',
          requiresChanges: true,
          path: 'a.ts',
          line: 1,
        },
      ],
    },
  });

  assert.doesNotMatch(summary, /  $/mu);
});

test('a location is displayed exactly as the CLI reported it, tabs and doubled spaces included', () => {
  const summary = summaryFor({
    outcome: {
      ...result().outcome,
      findings: [
        {
          severity: 'major',
          title: 'Two  spaces and a\ttab in the title',
          requiresChanges: true,
          path: 'dir/a\tb  c.ts',
          line: 3,
        },
      ],
    },
  });

  assert.match(summary, /`dir\/a\tb  c\.ts:3`/u, 'the path is not rewritten');
  assert.match(summary, /Two  spaces and a\ttab in the title/u);
});

test('a judgement keeps its paragraph boundaries, however they are encoded', () => {
  for (const [ending, label] of [
    ['\n\n', 'LF LF'],
    ['\r\n\r\n', 'CRLF CRLF'],
    ['\r\r', 'CR CR'],
    ['\u2029', 'paragraph separator'],
  ]) {
    const summary = summaryFor({
      outcome: {
        ...result().outcome,
        judgement: `First paragraph.${ending}Second paragraph.`,
      },
    });

    assert.match(
      summary,
      /First paragraph\.\n\nSecond paragraph\./u,
      `${label} must separate two paragraphs`,
    );
  }
});

test('a single line ending inside a paragraph stays a single break', () => {
  const summary = summaryFor({
    outcome: {
      ...result().outcome,
      judgement: 'One line.\r\nStill the same paragraph.',
    },
  });

  assert.match(summary, /One line\.\nStill the same paragraph\./u);
  assert.doesNotMatch(summary, /One line\.\n\nStill/u);
});
