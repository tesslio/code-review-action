# Architecture

The GitHub Action is an adapter around the Tessl Code Review CLI command. It
does not define review behavior or repository policy.

## Ownership

| Surface | Responsibility |
| --- | --- |
| Calling workflow | Triggers, concurrency, runner, timeout, permissions, secret selection, profile, effort and lens selection, review mode, and branch protection. |
| Code Review Action | Pull-request resolution, exact-head checkout, CLI installation and invocation, the check run on the reviewed head, artifacts, and visible failures. |
| Tessl CLI | Review configuration, review execution, reconciliation, judgment, structured outcomes, and publishing the review to the pull request — including idempotency and stale-head protection. |

## Execution sequence

1. The calling workflow decides when a review should run.
2. The Action resolves the open pull request and exact head.
3. The Action opens a check run against that head, when permitted.
4. Support code runs from the pinned Action revision.
5. The pull-request head is checked out without persisted credentials.
6. The Action installs the Tessl CLI the caller selected and runs the selected
   profile and lenses.
7. The CLI reviews the change, publishes one GitHub review for it, and returns a
   structured outcome carrying what it published.
8. The Action uploads a versioned result artifact.
9. The Action concludes the check run with the terminal status.

The declared inputs, outputs, permissions, and artifact schemas form the
compatibility boundary. File layout and helper scripts do not.
