import { GitHubApiError } from './github-api.mjs';

export const CHECK_NAME = 'Tessl Code Review';

// A maintainer can act on this one by granting the permission, so it is worth
// a warning. Every other reporting failure stays a notice.
const PERMISSION_WARNING =
  '::warning::Tessl Code Review did not report its status check because the workflow does not grant the checks: write permission. Add "checks: write" to the calling job permissions to report the review result on the reviewed commit.';

const REPORTS = {
  approved: {
    gate: 'success',
    advisory: 'success',
    title: 'Changes approved',
    summary: 'Tessl Code Review approved the changes in this commit.',
  },
  // Gate mode decides an outcome with findings as approval or requested
  // changes, so it never reaches this status. It stays neutral in gate mode so
  // that an outcome this revision cannot decide is not reported as a pass.
  'advisory-findings': {
    gate: 'neutral',
    advisory: 'neutral',
    title: 'Findings reported',
    summary: {
      advisory:
        'Tessl Code Review reported findings for this commit. Advisory mode does not block the pull request.',
      gate: 'Tessl Code Review reported findings for this commit.',
    },
  },
  'changes-requested': {
    gate: 'failure',
    advisory: 'neutral',
    title: 'Changes requested',
    summary: 'Tessl Code Review requested changes for this commit.',
  },
  'technical-failure': {
    gate: 'failure',
    advisory: 'neutral',
    title: 'Review did not complete',
    summary:
      'Tessl Code Review did not complete for this commit. Open the workflow run for details.',
  },
  'publication-failure': {
    gate: 'failure',
    advisory: 'neutral',
    title: 'Review was not published',
    summary:
      'Tessl Code Review completed but could not publish its review for this commit. Open the workflow run for details.',
  },
  'gate-configuration-failure': {
    gate: 'failure',
    advisory: 'neutral',
    title: 'Repository settings blocked the review event',
    summary:
      'GitHub did not allow the workflow to submit the requested review event, so the complete review was published as a comment. Check the repository GitHub Actions and pull-request review settings.',
  },
  'incompatible-cli': {
    gate: 'failure',
    advisory: 'neutral',
    title: 'Incompatible Tessl CLI',
    summary:
      'The Tessl CLI that ran did not report which commit it reviewed, so this check cannot be concluded for the reviewed head. Set the Action\'s cli-version input to a release that reports it.',
  },
  'gate-verdict-failure': {
    gate: 'failure',
    advisory: 'neutral',
    title: 'Review verdict missing',
    summary:
      'Tessl Code Review returned no approval verdict for this commit, so gate mode could not establish whether the commit passes. Open the workflow run for details.',
  },
  superseded: {
    gate: 'neutral',
    advisory: 'neutral',
    title: 'Superseded before publication',
    summary:
      'A newer commit was pushed to this pull request while the review was running, so no review was published for this commit and it carries no review verdict. The workflow run is marked failed to keep an unpublished review from reading as a pass. Nothing needs fixing: a run against the current head reviews the newer commit.',
  },
  // Neutral in both modes, like every other status that asserts nothing about
  // the commit. Under gate mode a neutral conclusion on a required check holds
  // the pull request, which is the honest position: nothing reviewed this
  // commit, so nothing has passed it.
  'refused-approval-request': {
    gate: 'neutral',
    advisory: 'neutral',
    title: 'Approval request refused',
    summary:
      'No review was run in its place. Approving is limited to owners, members, and collaborators, plus any login the workflow names in approver-logins. Comment @tessl-code-review to have the change reviewed.',
  },
  'skipped-no-matching-lenses': {
    gate: 'neutral',
    advisory: 'neutral',
    title: 'No matching review lenses',
    summary:
      'No configured review lenses matched the files changed in this commit, so Tessl Code Review made no review assertion.',
  },
};

const UNRECOGNIZED_REPORT = {
  gate: 'neutral',
  advisory: 'neutral',
  title: 'Review status unrecognized',
  summary:
    'Tessl Code Review finished with a status this revision of the Action does not recognize. Open the workflow run for details.',
};

// A summary is one sentence set for both modes unless the modes need different
// wording, in which case it is keyed by mode.
function summaryFor(report, mode) {
  return typeof report.summary === 'string'
    ? report.summary
    : report.summary[mode];
}

/**
 * Maps a terminal Action status onto the check-run conclusion and output text
 * for the requested mode. Advisory never concludes failure, so requiring the
 * check in branch protection cannot turn advisory mode into a gate.
 *
 * A `reason` is the CLI's own sentence about why it stopped, and follows the
 * status sentence rather than replacing it: the status is what the check
 * asserts about the commit, and the reason is what the maintainer fixes. The
 * caller decides which reasons are publishable; this renders whatever it is
 * given inside a code span, so it must arrive safe for one.
 */
export function checkRunReport({ mode, status, reason }) {
  if (mode !== 'advisory' && mode !== 'gate') {
    throw new Error('mode must be advisory or gate.');
  }
  const report = REPORTS[status] ?? UNRECOGNIZED_REPORT;
  const summary = summaryFor(report, mode);
  return {
    conclusion: report[mode],
    title: report.title,
    summary: reason ? `${summary}\n\nThe Tessl CLI reported: \`${reason}\`` : summary,
  };
}

// A 403 also covers rate limits and organization policy, which no permission
// grant fixes, so only GitHub's own permission wording selects that message.
function isMissingPermission(error) {
  return (
    error instanceof GitHubApiError &&
    error.status === 403 &&
    String(error.body).includes('Resource not accessible by integration')
  );
}

function annotation(error) {
  if (isMissingPermission(error)) return PERMISSION_WARNING;
  return `::notice::Tessl Code Review could not report its status check: ${error}. The review itself is unaffected.`;
}

export async function startReviewCheckRun({
  api,
  headSha,
  detailsUrl,
  log = console,
}) {
  try {
    const created = await api.createCheckRun({
      name: CHECK_NAME,
      head_sha: headSha,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      details_url: detailsUrl,
      output: {
        title: 'Review in progress',
        summary: `Tessl Code Review is reviewing ${headSha}.`,
      },
    });
    return created?.id;
  } catch (error) {
    log.log(annotation(error));
    return undefined;
  }
}

export async function concludeReviewCheckRun({
  api,
  checkRunId,
  mode,
  status,
  reason,
  detailsUrl,
  log = console,
}) {
  try {
    const report = checkRunReport({ mode, status, reason });
    await api.updateCheckRun(checkRunId, {
      status: 'completed',
      conclusion: report.conclusion,
      completed_at: new Date().toISOString(),
      details_url: detailsUrl,
      output: { title: report.title, summary: report.summary },
    });
    return report;
  } catch (error) {
    log.log(annotation(error));
    return undefined;
  }
}
