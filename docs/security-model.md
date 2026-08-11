# Security model

## Trust boundaries

- Pull-request code, diffs, branches, comments, titles, and repository files are
  untrusted input.
- The pinned Action revision and pinned dependencies are trusted code.
- GitHub and Tessl responses are validated at their contracts.

## Required controls

### Trusted execution

- Resolve the exact open pull-request head.
- Run support code from the pinned Action's `GITHUB_ACTION_PATH`.
- Check out the pull-request head separately with persisted credentials
  disabled.
- Do not execute code from the reviewed checkout.

### Credentials

- Require callers to grant minimal GitHub permissions.
- Use the automatic `github.token` for GitHub publication.
- Accept the Tessl credential only through the declared Action input.
- Never place credentials in command arguments, logs, outputs, or artifacts.

### Publication integrity

- Verify the pull-request head immediately before publication.
- Use stable markers and receipts for idempotent retries.
- Reconcile an ambiguous create response before another publication attempt.
- Do not publish a review for a superseded head.
- Report the check run against the resolved reviewed head only, and never
  assert a verdict for a head that was not reviewed.
- Treat check-run reporting as optional. A missing permission produces a
  visible warning and never changes the review outcome.

### Data minimization

- Build uploaded artifacts from an explicit allowlist of fields, so a field the
  CLI adds later is dropped until it is added to the documented schema.
- Do not include prompts, source contents, credentials, or debug output.

### Comment-driven triggers

An `issue_comment` run holds the repository write permissions and the Tessl
credential, and anyone able to comment on a pull request can start one. Deciding
who may do that is the caller's responsibility: the Action authenticates nothing
about the commenter. Gate the job on the actor, by `author_association` or by a
step that queries the commenter's permission level, before adding a
comment-driven workflow.

### Forks

Cross-repository pull requests are not supported. The Action rejects them
before review execution.

## Failure policy

- Review and publication failures are visible to maintainers.
- A stale-head check fails closed.
- Retries must not create duplicate reviews.
