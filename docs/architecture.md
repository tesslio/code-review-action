# Architecture

The GitHub Action is an adapter around the Tessl Code Review CLI command. It
does not define review behavior or repository policy.

## Ownership

| Surface | Responsibility |
| --- | --- |
| Calling workflow | Triggers, concurrency, runner, timeout, permissions, secret selection, profile, model, effort and lens selection, review mode, and branch protection. |
| Code Review Action | Pull-request resolution, exact-head checkout, CLI installation and invocation, GitHub review publication, the check run on the reviewed head, idempotency, stale-head protection, artifacts, and visible failures. |
| Tessl CLI | Review configuration, review execution, reconciliation, judgment, and structured outcomes. |

## Execution sequence

1. The calling workflow decides when a review should run.
2. The Action resolves the open pull request and exact head.
3. The Action opens a check run against that head, when permitted.
4. Support code runs from the pinned Action revision.
5. The pull-request head is checked out without persisted credentials.
6. The Action installs a pinned Tessl CLI and runs the selected profile and
   lenses.
7. The CLI returns a structured outcome.
8. The Action verifies the head again and creates or reuses one GitHub review.
9. The Action uploads a versioned result artifact.
10. The Action concludes the check run with the terminal status.

The declared inputs, outputs, permissions, and artifact schemas form the
compatibility boundary. File layout and helper scripts do not.
