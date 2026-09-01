/**
 * The review, written to the workflow run's job summary.
 *
 * The run page says nothing about a review today: the CLI's human output goes
 * into the result file behind `--json`, the findings are not annotations, and
 * the only machine-readable artifact is a zip. This renders the same review the
 * pull request carries, from the same result document, so a reader sees one
 * review in two places rather than two summaries of it.
 *
 * It is written for every terminal status, including the ones that published
 * nothing. That failure case is what justifies the summary existing: when
 * publication fails, this is the only place a completed review can still be
 * read.
 *
 * Cost is deliberately absent. The summary reports what the review found and
 * what it asserted about the commit; what the round spent is not part of that.
 *
 * Everything the model wrote — the judgement, the finding titles — is untrusted
 * input reaching a rendered surface, so it is bounded here: control characters
 * removed, length capped, and never interpolated into anything but Markdown
 * text. The whole summary is capped an order of magnitude inside GitHub's own
 * limit, so a long review cannot silently lose its own verdict.
 */

import { appendFile } from 'node:fs/promises';

import { checkRunReport } from './check-run.mjs';
import { PUBLISHED_STATUSES, publicationReceipt } from './result-file.mjs';

/** Ordered worst-first. An unrecognised severity sorts after every known one. */
const SEVERITY_RANK = ['critical', 'major', 'minor', 'nit'];

/** Control characters, which corrupt a rendered page rather than appearing in it. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

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

/**
 * Model-authored text, made safe to place in Markdown as one line.
 *
 * Newlines collapse because a finding title is a single line in a list, and an
 * embedded newline would break out of it.
 */
function text(value, limit) {
  if (typeof value !== 'string') return '';
  const collapsed = value
    .replaceAll(CONTROL_CHARACTERS, '')
    .replaceAll(/\s*\n\s*/gu, ' ')
    .trim();
  return collapsed.length > limit
    ? `${collapsed.slice(0, limit).trimEnd()}…`
    : collapsed;
}

/** Multi-line model text: the same cleaning, but paragraphs survive. */
function paragraphs(value, limit) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replaceAll(CONTROL_CHARACTERS, '').trim();
  return cleaned.length > limit
    ? `${cleaned.slice(0, limit).trimEnd()}…`
    : cleaned;
}

function severityLabel(severity) {
  const cleaned = text(severity, 40);
  return cleaned === ''
    ? 'Unknown'
    : `${cleaned[0].toUpperCase()}${cleaned.slice(1)}`;
}

/**
 * A lens ref as a reader should see it: the leaf skill name, de-hyphenated.
 * Mirrors how the published review names a lens, so the two agree.
 */
function lensLabel(ref) {
  const selected = String(ref).split('#').at(-1) ?? '';
  const segments = selected.split('/').filter(Boolean);
  const leaf =
    segments.at(-1) === 'SKILL.md' ? segments.at(-2) : segments.at(-1);
  const words = String(leaf ?? '')
    .replace(/^review-/u, '')
    .split('-')
    .filter(Boolean);
  if (words.length === 0) return text(ref, 80);
  return words
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

/** A finding carries its location nested or flat, and both forms are published. */
function findingLocation(finding) {
  const path = finding?.path ?? finding?.location?.path;
  const line = finding?.line ?? finding?.location?.line;
  const label = [path, line].filter((part) => part !== undefined).join(':');
  return text(label, LOCATION_LIMIT);
}

function severityIndex(severity) {
  const index = SEVERITY_RANK.indexOf(String(severity));
  return index === -1 ? SEVERITY_RANK.length : index;
}

/** Worst severity first; findings of one severity keep the outcome's order. */
function bySeverity(findings) {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) =>
        severityIndex(a.finding?.severity) -
          severityIndex(b.finding?.severity) || a.index - b.index,
    )
    .map((entry) => entry.finding);
}

function renderFindingList(findings) {
  const listed = bySeverity(findings).slice(0, LISTED_FINDINGS_LIMIT);
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

export function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0
    ? `${seconds}s`
    : `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** The run's facts, as one line. Never a cost. */
function renderContext({ result, mode, headSha }) {
  const lenses = result?.outcome?.lenses;
  const durationMs = result?.diagnostics?.durationMs;
  const reviewedHead = result?.outcome?.subject?.change?.headRevision ?? headSha;
  const parts = [mode];
  if (Array.isArray(lenses)) {
    parts.push(`${lenses.length} ${lenses.length === 1 ? 'lens' : 'lenses'}`);
  }
  if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
    parts.push(formatDuration(durationMs));
  }
  if (
    typeof reviewedHead === 'string' &&
    /^[0-9a-f]{7,40}$/iu.test(reviewedHead)
  ) {
    parts.push(`\`${reviewedHead.slice(0, 7)}\``);
  }
  const line = parts.filter((part) => typeof part === 'string' && part !== '');
  return line.length === 0 ? [] : ['', line.join(' · ')];
}

function renderLensSet(result) {
  const lenses = result?.outcome?.lenses;
  if (!Array.isArray(lenses) || lenses.length === 0) return [];
  const labels = [
    ...new Set(
      lenses
        .map((lens) =>
          typeof lens?.ref === 'string' ? lensLabel(lens.ref) : '',
        )
        .filter((label) => label !== ''),
    ),
  ];
  return labels.length === 0 ? [] : ['', `Lenses: ${labels.join(' · ')}`];
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

/** The statuses whose run completed a review it could not fully publish. */
const UNPUBLISHED_REVIEW_STATUSES = new Set([
  'publication-failure',
  'gate-configuration-failure',
  'superseded',
]);

/**
 * The summary for a run that produced an outcome: the verdict, the judgement,
 * what it found, and where to read it in full.
 *
 * Findings are partitioned the way the verdict is computed — by
 * `requiresChanges` — rather than by severity, so the summary groups them the
 * way the product decided them.
 */
function renderReviewedSummary({ result, mode, headSha, repository, prNumber }) {
  const outcome = result.outcome;
  const findings = Array.isArray(outcome.findings) ? outcome.findings : [];
  const mustFix = findings.filter(
    (finding) => finding?.requiresChanges === true,
  );
  const suggestions = findings.filter(
    (finding) => finding?.requiresChanges !== true,
  );
  const heading =
    outcome.approved === true
      ? '### Changes approved'
      : `### Changes requested (${mustFix.length})`;
  const judgement = paragraphs(outcome.judgement, JUDGEMENT_LIMIT);

  return [
    '## Tessl Code Review',
    '',
    heading,
    ...(outcome.approved === true && suggestions.length > 0
      ? [
          '',
          `${suggestions.length} optional ${suggestions.length === 1 ? 'suggestion' : 'suggestions'}. Nothing blocking.`,
        ]
      : []),
    ...renderContext({ result, mode, headSha }),
    ...(judgement === '' ? [] : ['', judgement]),
    ...renderSeverityTable(findings),
    ...(mustFix.length === 0
      ? []
      : ['', '#### Must fix', '', ...renderFindingList(mustFix)]),
    ...(suggestions.length === 0
      ? []
      : [
          '',
          `#### Suggestions (${suggestions.length})`,
          '',
          ...renderFindingList(suggestions),
        ]),
    ...renderEarlierFindings(outcome.reconciliation),
    ...renderLensSet(result),
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
      ? ['', `The Tessl CLI reported: \`${text(reason, TITLE_LIMIT)}\``]
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
  headSha,
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
        ...renderReviewedSummary({
          result,
          mode,
          headSha,
          repository,
          prNumber,
        }),
        ...(UNPUBLISHED_REVIEW_STATUSES.has(status)
          ? [
              '',
              `> ${checkRunReport({ mode, status, reason: undefined }).summary}`,
              ...(typeof runUrl === 'string' && runUrl !== ''
                ? ['', `[View the workflow run](${runUrl})`]
                : []),
            ]
          : []),
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
