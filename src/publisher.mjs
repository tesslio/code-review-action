import { GitHubApiError } from './github-api.mjs';
import {
  FAILURE_MARKER,
  attemptMarker,
  buildFallbackBody,
  buildPublicationPlan,
  mayContinueOnPriorThread,
  planConversationReplies,
  readOutcome,
  selectPriorReconciliation,
} from './protocol.mjs';

function isUnresolvableLine(error) {
  if (!(error instanceof GitHubApiError) || error.status !== 422) return false;
  try {
    const response = JSON.parse(error.body);
    return response.errors?.some(
      (item) =>
        item?.resource === 'PullRequestReviewComment' &&
        (item?.field === 'line' || item?.field === 'position'),
    );
  } catch {
    return false;
  }
}

function isReviewEventRejected(error, reviewEvent) {
  return (
    reviewEvent !== 'COMMENT' &&
    error instanceof GitHubApiError &&
    (error.status === 403 || error.status === 422)
  );
}

function isAmbiguousCreateFailure(error) {
  return !(error instanceof GitHubApiError) || error.status >= 500;
}

async function createReviewWithReconciliation({
  api,
  prNumber,
  expectedHeadSha,
  marker,
  payload,
}) {
  try {
    return {
      review: await api.createReview(prNumber, payload),
      reconciled: false,
    };
  } catch (error) {
    if (!isAmbiguousCreateFailure(error)) throw error;

    // A connection can fail after GitHub accepts the POST. Never submit a
    // second review until the attempt marker proves the first one is absent.
    let reviews;
    try {
      reviews = await api.reviews(prNumber);
    } catch {
      throw error;
    }
    const accepted = reviews.find(
      (review) =>
        review.commit_id === expectedHeadSha &&
        String(review.body ?? '').includes(marker),
    );
    if (!accepted) throw error;
    return { review: accepted, reconciled: true };
  }
}

function policyFallbackBody(body, reviewEvent) {
  const action =
    reviewEvent === 'APPROVE'
      ? 'approve this pull request'
      : 'request changes';
  return [
    `> Tessl Code Review completed, but GitHub did not allow the workflow to ${action}. The complete review is published as a comment instead. Check the repository's GitHub Actions and pull-request review settings.`,
    '',
    body,
  ].join('\n');
}

function supersededReceipt(reviewedHeadSha, currentHeadSha) {
  return {
    schemaVersion: 1,
    status: 'superseded',
    reviewedHeadSha,
    currentHeadSha,
  };
}

function publishedReviewLabel(mode) {
  return mode === 'gate' ? 'The gate review' : 'The advisory review';
}

async function replyToPriorFindingThreads({
  api,
  prNumber,
  reconciliation,
  findings,
  mode,
  log,
}) {
  try {
    const comments = await api.reviewComments(prNumber);
    const replies = planConversationReplies({
      reconciliation,
      findings,
      reviewComments: comments,
    });
    const attempts = await Promise.allSettled(
      replies.map((reply) =>
        api.reply(prNumber, reply.rootCommentId, reply.body),
      ),
    );
    const failures = attempts.filter(
      (attempt) => attempt.status === 'rejected',
    );
    if (failures.length > 0) {
      log.warn(
        `${publishedReviewLabel(mode)} was published, but ${failures.length} conversation repl${failures.length === 1 ? 'y was' : 'ies were'} incomplete.`,
      );
    }
  } catch (error) {
    log.warn(
      `${publishedReviewLabel(mode)} was published, but conversation replies were incomplete: ${error}`,
    );
  }
}

// Read before publication so a still-applying finding is only published as
// continuing when a thread actually carries it. A failure is not fatal: the plan
// falls back to trusting the reported disposition, which is how it behaved before
// it could check at all.
async function priorReviewCommentsBestEffort({ api, prNumber, mode, log }) {
  try {
    return await api.reviewComments(prNumber);
  } catch (error) {
    log.warn(
      `${publishedReviewLabel(mode)} could not read earlier review comment threads, so continuing findings are reported as the review described them: ${error}`,
    );
    return undefined;
  }
}

async function removeFailureNoticesBestEffort({ api, prNumber, mode, log }) {
  try {
    await removeFailureNotices({ api, prNumber });
  } catch (error) {
    log.warn(
      `${publishedReviewLabel(mode)} was published, but stale failure notices could not be removed: ${error}`,
    );
  }
}

async function applyPostPublicationUpdates(args) {
  await replyToPriorFindingThreads(args);
  await removeFailureNoticesBestEffort(args);
}

export async function publishCodeReview({
  api,
  prNumber,
  expectedHeadSha,
  attemptId,
  result,
  reviewEvent = 'COMMENT',
  mode = 'advisory',
  log = console,
}) {
  if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(reviewEvent)) {
    throw new Error(`Unsupported GitHub review event ${reviewEvent}.`);
  }
  const outcome = readOutcome(result);
  if (outcome.subject.change.headRevision !== expectedHeadSha) {
    throw new Error(
      `Refusing to publish: the outcome reviewed ${outcome.subject.change.headRevision}, expected ${expectedHeadSha}.`,
    );
  }

  const pr = await api.pullRequest(prNumber);
  if (pr.head.sha !== expectedHeadSha) {
    log.warn(
      `Review ${expectedHeadSha} was superseded by ${pr.head.sha}; no review was published.`,
    );
    return supersededReceipt(expectedHeadSha, pr.head.sha);
  }

  const marker = attemptMarker(attemptId);
  const existing = await api.reviews(prNumber);
  const previousPublication = existing.find(
    (review) =>
      review.commit_id === expectedHeadSha &&
      String(review.body ?? '').includes(marker),
  );
  if (previousPublication) {
    await applyPostPublicationUpdates({
      api,
      prNumber,
      reconciliation: selectPriorReconciliation(outcome.reconciliation),
      findings: outcome.findings,
      mode,
      log,
    });
    return {
      schemaVersion: 1,
      status: 'reused',
      reviewId: previousPublication.id,
    };
  }

  const files = outcome.findings.some(
    (finding) => finding.location?.path && finding.location?.line,
  )
    ? await api.files(prNumber)
    : [];
  // Read only when this outcome could continue a finding on an earlier thread,
  // the same way the diff is read only when a finding could be placed on it.
  // `undefined` records that the threads are unknown rather than absent, so a
  // failure here costs accounting accuracy and never duplicates a comment.
  const reviewComments = mayContinueOnPriorThread(outcome)
    ? await priorReviewCommentsBestEffort({ api, prNumber, mode, log })
    : undefined;
  const plan = buildPublicationPlan({
    outcome,
    files,
    attemptId,
    reviewComments,
  });
  let inline = plan.inline;
  let usedFallback = false;
  let policyFallback = false;
  let reconciled = false;
  let publishedReview;

  // File pagination and plan construction can take time. Refresh the head at
  // the last safe point before the mutating request so stale findings do not
  // get published after a push.
  const current = await api.pullRequest(prNumber);
  if (current.head.sha !== expectedHeadSha) {
    log.warn(
      `Review ${expectedHeadSha} was superseded by ${current.head.sha}; no review was published.`,
    );
    return supersededReceipt(expectedHeadSha, current.head.sha);
  }

  try {
    const created = await createReviewWithReconciliation({
      api,
      prNumber,
      expectedHeadSha,
      marker,
      payload: {
        commit_id: expectedHeadSha,
        event: reviewEvent,
        body: plan.body,
        comments: inline,
      },
    });
    publishedReview = created.review;
    reconciled = created.reconciled;
  } catch (error) {
    if (isUnresolvableLine(error) && inline.length > 0) {
      usedFallback = true;
      try {
        const created = await createReviewWithReconciliation({
          api,
          prNumber,
          expectedHeadSha,
          marker,
          payload: {
            commit_id: expectedHeadSha,
            event: reviewEvent,
            body: buildFallbackBody(plan),
            comments: [],
          },
        });
        publishedReview = created.review;
        reconciled = created.reconciled;
        inline = [];
      } catch (fallbackError) {
        if (!isReviewEventRejected(fallbackError, reviewEvent)) {
          throw fallbackError;
        }
        const created = await createReviewWithReconciliation({
          api,
          prNumber,
          expectedHeadSha,
          marker,
          payload: {
            commit_id: expectedHeadSha,
            event: 'COMMENT',
            body: policyFallbackBody(buildFallbackBody(plan), reviewEvent),
            comments: [],
          },
        });
        publishedReview = created.review;
        reconciled = created.reconciled;
        inline = [];
        policyFallback = true;
      }
    } else if (isReviewEventRejected(error, reviewEvent)) {
      const created = await createReviewWithReconciliation({
        api,
        prNumber,
        expectedHeadSha,
        marker,
        payload: {
          commit_id: expectedHeadSha,
          event: 'COMMENT',
          body: policyFallbackBody(plan.body, reviewEvent),
          comments: inline,
        },
      });
      publishedReview = created.review;
      reconciled = created.reconciled;
      policyFallback = true;
    } else {
      throw error;
    }
  }

  await applyPostPublicationUpdates({
    api,
    prNumber,
    reconciliation: plan.priorReconciliation,
    findings: outcome.findings,
    mode,
    log,
  });

  if (policyFallback) {
    return {
      schemaVersion: 1,
      status: 'published-with-policy-fallback',
      reviewId: publishedReview.id,
      intendedEvent: reviewEvent,
      publishedEvent: 'COMMENT',
      reason: 'review-event-not-permitted',
      inlineCount: inline.length,
      unplacedCount:
        plan.unplaced.length + (usedFallback ? plan.inline.length : 0),
      usedFallback,
      reconciled,
    };
  }

  return {
    schemaVersion: 1,
    status: 'published',
    reviewId: publishedReview.id,
    intendedEvent: reviewEvent,
    publishedEvent: reviewEvent,
    inlineCount: inline.length,
    unplacedCount:
      plan.unplaced.length + (usedFallback ? plan.inline.length : 0),
    usedFallback,
    reconciled,
  };
}

export async function publishFailureNotice({ api, prNumber, runUrl }) {
  const body = `${FAILURE_MARKER}\nTessl Code Review did not complete. [View the workflow run](${runUrl}).`;
  const comments = await api.issueComments(prNumber);
  const existing = comments.find(
    (comment) =>
      comment.user?.login === 'github-actions[bot]' &&
      String(comment.body ?? '').includes(FAILURE_MARKER),
  );
  if (existing) {
    await api.updateIssueComment(existing.id, body);
    return { status: 'updated', commentId: existing.id };
  }
  const created = await api.createIssueComment(prNumber, body);
  return { status: 'created', commentId: created.id };
}

export async function removeFailureNotices({ api, prNumber }) {
  const comments = await api.issueComments(prNumber);
  const stale = comments.filter(
    (comment) =>
      comment.user?.login === 'github-actions[bot]' &&
      String(comment.body ?? '').includes(FAILURE_MARKER),
  );
  for (const comment of stale) await api.deleteIssueComment(comment.id);
  return stale.length;
}
