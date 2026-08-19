# Tessl Code Review Action

This repository distributes the GitHub Action for Tessl Code Review.

## Boundaries

- `action.yml` is the only supported entry point.
- Callers own triggers, concurrency, runners, timeouts, permissions, secrets,
  and branch protection.
- The Action owns mention acknowledgement, pull-request resolution, checkout,
  CLI setup, the check run, artifacts, and failure reporting.
- The CLI publishes the review, its inline findings, and the replies that
  reconcile findings across rounds.
- Review behavior and configuration belong to the Tessl CLI and review
  profiles.

## Conventions

- Pin every third-party Action by full commit SHA with a version comment.
- Keep permissions explicit and minimal in examples.
- Treat pull-request content and repository files as untrusted input.
- Run support code from `GITHUB_ACTION_PATH`, never from the reviewed checkout.
- Do not persist credentials in the reviewed checkout.
- Use Conventional Commits.
- Keep public documentation focused on supported behavior.

## Verification

```bash
bash scripts/validate-foundation.sh
```

Add regression coverage for changes to publication, idempotency, stale-head
handling, failure behavior, artifacts, or credential boundaries.
