/**
 * The review, written to the workflow run's job summary.
 *
 * The run page says nothing about a review today: the CLI's human output goes
 * into the result file behind `--json`, the findings are not annotations, and
 * the only machine-readable artifact is a zip.
 *
 * There are two designs for a review and only two: a **markdown** one and a
 * **CLI text** one. This is the markdown one, and so is the published
 * pull-request review body — the two must read as one design in two places, so
 * this mirrors that body's shape deliberately: the same verdict heading, the
 * same optional-suggestion line, the judgement, the severity table ordered
 * worst-first, and one flat `#### Findings` list.
 *
 * In particular it does **not** group findings into must-fix and suggestions.
 * That grouping belongs to the CLI text design alone. Copying it here would
 * make the two markdown surfaces disagree about the most important structural
 * choice either of them makes.
 *
 * It is written for every terminal status, including the ones that published
 * nothing. That failure case is what justifies the summary existing: when
 * publication fails, this is the only place a completed review can still be
 * read.
 *
 * Cost is deliberately absent. The summary reports what the review found and
 * what it asserted about the commit; what the round spent is not part of that.
 *
 * Everything the model wrote — the judgement, the finding titles, the locations
 * — is untrusted input reaching a rendered surface, so it is bounded here:
 * control and Unicode format characters removed (bidirectional overrides
 * included, so displayed text matches stored order), Markdown delimiters
 * escaped so nothing model-authored can create a heading, a link, an image or
 * raw HTML, and every value length-capped. The whole summary is capped an order
 * of magnitude inside GitHub's own limit, so a long review cannot silently lose
 * its own verdict.
 */

import { appendFile } from 'node:fs/promises';

import { checkRunReport } from './check-run.mjs';
import { PUBLISHED_STATUSES, publicationReceipt } from './result-file.mjs';

/** Ordered worst-first. An unrecognised severity sorts after every known one. */
const SEVERITY_RANK = ['critical', 'major', 'minor', 'nit'];

/**
 * Characters removed from every model-authored value.
 *
 * C0/C1 controls corrupt the rendered page rather than appearing in it, and
 * `\p{Cf}` — the Unicode format category — carries the bidirectional overrides
 * and invisible joiners that make displayed text differ from its stored order.
 * A reviewer reading a finding has to be reading the finding.
 */
const STRIPPED_CHARACTERS = /[\p{Cf}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

/**
 * Markdown delimiters escaped wherever model text is rendered as prose, so a
 * title or judgement cannot create a link, an image, emphasis, a code span or
 * raw HTML on a surface a reviewer reads as ours.
 */
const INLINE_MARKDOWN = /[\\`*_[\]<>|~]/gu;

/** Block openers, escaped only where they would start a block: at line start. */
const BLOCK_OPENER = /^(\s*)([#>+=-])/u;
const ORDERED_MARKER = /^(\s*)(\d{1,9})([.)])/u;

/** Enough for the longest judgement a supervisor has written, and bounded. */
const JUDGEMENT_LIMIT = 4000;
const TITLE_LIMIT = 300;
const LOCATION_LIMIT = 400;
/** GitHub accepts 1 MiB; staying an order of magnitude inside it is free. */
const SUMMARY_LIMIT = 100000;
/** A review longer than this has a lens problem the summary should not smooth over. */
const LISTED_FINDINGS_LIMIT = 50;

/** How each reconciliation category reads in the earlier-findings line. */
const RECONCILIATION_PROSE = {
  remaining: (count) => `${count} still ${count === 1 ? 'applies' : 'apply'}`,
  regressed: (count) => `${count} regressed`,
  addressed: (count) => `${count} addressed`,
  refuted: (count) => `${count} refuted`,
  declined: (count) => `${count} declined`,
};

/** Strip what must never render, whatever the value is used for. */
function stripped(value) {
  return typeof value === 'string' ? value.replaceAll(STRIPPED_CHARACTERS, '') : '';
}

function capped(value, limit) {
  return value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value;
}

function escapeInline(value) {
  return value.replaceAll(INLINE_MARKDOWN, (character) => `\\${character}`);
}

/**
 * Model-authored text rendered as one line of prose: stripped, collapsed onto a
 * single line so it cannot break out of the list item that holds it, escaped so
 * every Markdown delimiter in it is literal, then capped.
 */
function text(value, limit) {
  const collapsed = stripped(value)
    .replaceAll(/\s*\n\s*/gu, ' ')
    .trim();
  return capped(escapeInline(collapsed), limit);
}

/**
 * Model-authored text rendered inside a code span: stripped, collapsed, and its
 * backticks removed rather than escaped.
 *
 * Markdown delimiters are already inert inside a code span, so escaping them
 * would show the backslashes; the backtick is the one character that can close
 * the span, and it has no business in a path or a severity.
 */
function codeText(value, limit) {
  const collapsed = stripped(value)
    .replaceAll(/\s*\n\s*/gu, ' ')
    .replaceAll('`', '')
    .trim();
  return capped(collapsed, limit);
}

/**
 * The judgement: multi-line model text whose paragraphs are worth keeping.
 *
 * Inline delimiters are escaped as everywhere else, and each line's leading
 * block opener is escaped too — otherwise a judgement can open a heading and
 * state a verdict this summary never reached.
 */
function paragraphs(value, limit) {
  const escaped = escapeInline(stripped(value).trim())
    .split('\n')
    .map((line) =>
      line.replace(BLOCK_OPENER, '$1\\$2').replace(ORDERED_MARKER, '$1$2\\$3'),
    )
    .join('\n');
  return capped(escaped, limit);
}

/**
 * A severity as the table and the finding label show it.
 *
 * Rendered as prose in both places — a table cell, and inside a bold label — so
 * it is escaped like every other prose value rather than treated as code-span
 * content. An unescaped `|` would open a table column and an unescaped `*` would
 * break out of the label, and the CLI producing this value is the caller's to
 * choose, so it is bounded here rather than trusted.
 *
 * Capitalised before escaping, so a value that needs escaping still reads with
 * its first letter capitalised rather than a backslash.
 */
function severityLabel(severity) {
  const cleaned = stripped(severity)
    .replaceAll(/\s*\n\s*/gu, ' ')
    .trim();
  if (cleaned === '') return 'Unknown';
  const titled = `${cleaned[0].toUpperCase()}${cleaned.slice(1)}`;
  return capped(escapeInline(titled), 40);
}

/** A finding carries its location nested or flat, and both forms are published. */
function findingLocation(finding) {
  const path = finding?.path ?? finding?.location?.path;
  const line = finding?.line ?? finding?.location?.line;
  const label = [path, line].filter((part) => part !== undefined).join(':');
  return codeText(label, LOCATION_LIMIT);
}

function severityIndex(severity) {
  const index = SEVERITY_RANK.indexOf(String(severity));
  return index === -1 ? SEVERITY_RANK.length : index;
}

/**
 * Which findings the capped list renders, when there are more than it will show.
 *
 * The cap cannot be a plain prefix. A valid outcome can carry fifty optional
 * findings followed by a blocking one, and a prefix would then print a
 * requested-changes count with none of the details of the finding that caused it
 * — on the one surface that is the readable review when publication fails.
 *
 * So selection prefers what requires changes, and the selected set is then
 * rendered in the outcome's own order, which is the presentation this surface
 * documents. With more blocking findings than the cap, even those are capped;
 * the caller reports how many were not listed either way.
 */
function selectListedFindings(findings) {
  if (findings.length <= LISTED_FINDINGS_LIMIT) return findings;
  const blocking = findings.filter((finding) => finding?.requiresChanges === true);
  const optional = findings.filter((finding) => finding?.requiresChanges !== true);
  const listedBlocking = blocking.slice(0, LISTED_FINDINGS_LIMIT);
  const room = Math.max(0, LISTED_FINDINGS_LIMIT - listedBlocking.length);
  const selected = new Set([...listedBlocking, ...optional.slice(0, room)]);
  return findings.filter((finding) => selected.has(finding));
}

/**
 * The findings, as the published body lists them: one flat list, in the
 * outcome's own order.
 *
 * Not sorted here. The body lists what it placed inline followed by what
 * continues on an earlier thread, both in outcome order, and a different order
 * on this surface would be a second design rather than the same one. Which
 * findings survive a cap is a separate question — see above.
 */
function renderFindingList(findings) {
  const listed = selectListedFindings(findings);
  const lines = listed.map((finding) => {
    const location = findingLocation(finding);
    const suffix = location === '' ? '' : `\n  \`${location}\``;
    return `- **${severityLabel(finding?.severity)}** · ${text(finding?.title, TITLE_LIMIT)}${suffix}`;
  });
  const hidden = findings.length - listed.length;
  return hidden > 0 ? [...lines, `- _and ${hidden} more._`] : lines;
}

function renderSeverityTable(findings) {
  const counts = new Map();
  for (const finding of findings) {
    const key = String(finding?.severity);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rows = [...counts].sort(
    ([a], [b]) => severityIndex(a) - severityIndex(b),
  );
  if (rows.length === 0) return [];
  return [
    '',
    '| Severity | Findings |',
    '| --- | ---: |',
    ...rows.map(
      ([severity, count]) => `| ${severityLabel(severity)} | ${count} |`,
    ),
  ];
}

function renderEarlierFindings(reconciliation) {
  if (!Array.isArray(reconciliation) || reconciliation.length === 0) return [];
  const counts = new Map();
  for (const entry of reconciliation) {
    const category = String(entry?.category);
    if (RECONCILIATION_PROSE[category] === undefined) continue;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  if (counts.size === 0) return [];
  const parts = [...counts].map(([category, count]) =>
    RECONCILIATION_PROSE[category](count),
  );
  return ['', `**Earlier findings:** ${parts.join(' · ')}`];
}

/**
 * A link to the review, when one was actually published and the identifiers
 * needed to address it are all well formed. Checked rather than trusted: the
 * CLI version producing the receipt is the caller's to choose.
 */
function reviewLink({ result, repository, prNumber }) {
  const receipt = publicationReceipt(result);
  if (receipt === undefined || !PUBLISHED_STATUSES.has(receipt.status)) {
    return [];
  }
  if (
    receipt.reviewId === undefined ||
    typeof repository !== 'string' ||
    !/^[\w.-]+\/[\w.-]+$/u.test(repository) ||
    !/^[1-9]\d*$/u.test(String(prNumber ?? ''))
  ) {
    return [];
  }
  const url = `https://github.com/${repository}/pull/${prNumber}#pullrequestreview-${receipt.reviewId}`;
  return ['', `[View the published review](${url})`];
}

/**
 * The terminal statuses whose review stands for the head under check.
 *
 * Named as the set that *does* stand, so every other outcome-bearing status —
 * a publication that failed, a head superseded before publication, a policy
 * fallback, a gate with no boolean verdict, a CLI that never said what it
 * reviewed, and any status a later revision adds — carries the check's own
 * explanation beneath the review. Fails closed: an unrecognised status is
 * explained rather than presented as a verdict.
 */
const VERDICT_STANDS_STATUSES = new Set([
  'approved',
  'advisory-findings',
  'changes-requested',
]);

/**
 * The summary for a run that produced an outcome: the verdict, the judgement,
 * what it found, and where to read it in full.
 *
 * Findings are partitioned the way the verdict is computed — by
 * `requiresChanges` — rather than by severity, so the summary groups them the
 * way the product decided them.
 */
function renderReviewedSummary({ result, repository, prNumber }) {
  const outcome = result.outcome;
  const findings = Array.isArray(outcome.findings) ? outcome.findings : [];
  const requiresChangesCount = findings.filter(
    (finding) => finding?.requiresChanges === true,
  ).length;
  const optionalCount = findings.length - requiresChangesCount;
  const heading =
    outcome.approved === true
      ? '### Changes approved'
      : `### Changes requested (${requiresChangesCount})`;
  const judgement = paragraphs(outcome.judgement, JUDGEMENT_LIMIT);

  return [
    '## Tessl Code Review',
    '',
    heading,
    // The line that answers why an approving review still lists findings —
    // worded as the published body words it.
    ...(outcome.approved === true && optionalCount > 0
      ? [
          '',
          `${optionalCount} optional ${optionalCount === 1 ? 'suggestion' : 'suggestions'}. Nothing blocking.`,
        ]
      : []),
    ...(judgement === '' ? [] : ['', judgement]),
    ...renderSeverityTable(findings),
    ...(findings.length === 0
      ? []
      : ['', '#### Findings', '', ...renderFindingList(findings)]),
    ...renderEarlierFindings(outcome.reconciliation),
    ...reviewLink({ result, repository, prNumber }),
  ];
}

/**
 * The summary for a run with no outcome to show: the status the check run
 * reports, the CLI's own reason when there is a publishable one, and the run.
 *
 * The status sentence comes from `checkRunReport` rather than being written
 * again, so the summary and the check cannot describe one run differently.
 */
function renderStatusOnlySummary({ mode, status, reason, runUrl }) {
  const report = checkRunReport({ mode, status, reason: undefined });
  return [
    '## Tessl Code Review',
    '',
    `### ${report.title}`,
    '',
    report.summary,
    ...(typeof reason === 'string' && reason !== ''
      ? ['', `The Tessl CLI reported: \`${codeText(reason, TITLE_LIMIT)}\``]
      : []),
    ...(typeof runUrl === 'string' && runUrl !== ''
      ? ['', `[View the workflow run](${runUrl})`]
      : []),
  ];
}

/**
 * The Markdown for one run, whatever it managed to do.
 *
 * A result carrying an outcome renders the review even when publication failed
 * — that is the case this exists for, and the status is then stated under it so
 * a reader is not left thinking the review reached the pull request.
 */
export function reviewJobSummary({
  result,
  mode,
  status,
  reason,
  runUrl,
  repository,
  prNumber,
}) {
  const hasOutcome =
    result?.outcome !== undefined &&
    result?.outcome !== null &&
    typeof result.outcome === 'object';
  const lines = hasOutcome
    ? [
        ...renderReviewedSummary({ result, repository, prNumber }),
        ...(VERDICT_STANDS_STATUSES.has(status)
          ? []
          : [
              '',
              `> ${checkRunReport({ mode, status, reason: undefined }).summary}`,
              ...(typeof reason === 'string' && reason !== ''
                ? ['', `The Tessl CLI reported: \`${codeText(reason, TITLE_LIMIT)}\``]
                : []),
              ...(typeof runUrl === 'string' && runUrl !== ''
                ? ['', `[View the workflow run](${runUrl})`]
                : []),
            ]),
      ]
    : renderStatusOnlySummary({ mode, status, reason, runUrl });
  const body = `${lines.join('\n')}\n`;
  return body.length > SUMMARY_LIMIT
    ? `${body.slice(0, SUMMARY_LIMIT)}\n\n_Summary truncated._\n`
    : body;
}

/**
 * Append the summary to the run's job-summary file.
 *
 * Best effort by construction: the review is done either way, so a summary that
 * cannot be written is worth a notice rather than a failed job. Reports whether
 * anything was written.
 */
export async function writeJobSummary({ summaryPath, log = console, ...rest }) {
  if (typeof summaryPath !== 'string' || summaryPath === '') return false;
  try {
    await appendFile(summaryPath, reviewJobSummary(rest), 'utf8');
    return true;
  } catch (error) {
    log.log(
      `::notice::The review could not be written to the job summary: ${error}. The review itself is unaffected.`,
    );
    return false;
  }
}
