# Security model

## Trust boundaries

- Pull-request code, diffs, branches, comments, titles, and repository files are
  untrusted input.
- The pinned Action revision is trusted code.
- The Tessl CLI is trusted code, and is **not** pinned by this Action: callers
  track the current release by default. Pinning the Action's commit SHA
  therefore fixes this Action's behaviour, not the CLI's. A caller that needs
  both fixed sets `cli-version` to an exact release.
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
- Use the automatic `github.token` for everything the Action itself does: the
  comment reaction, pull-request resolution, the check run, the failure notice
  and the conclusion.
- Publish the review with the `github-token` input, which defaults to that same
  automatic token. A caller supplying another identity therefore grants it what
  reviewing needs and nothing the Action's own plumbing needs. A supplied token
  is checked for repository reachability before the review starts, so an
  invalid, expired or uninstalled credential reports itself rather than failing
  at publication. Whether it may review is the review endpoint's to answer:
  GitHub offers no pre-flight capability check, and the repository permission
  that looks like one describes content write, so gating on it would refuse the
  minimal configuration above.
- Accept the Tessl credential only through the declared Action input.
- Never place credentials in command arguments, logs, outputs, or artifacts.

### Publication integrity

Publication belongs to the CLI, and so do the controls that protect it: head
verification before every create, stable markers for idempotent retries,
reconciliation of an ambiguous create before another attempt, and refusing to
publish for a superseded head. What this Action still owes:

- Refuse to run a CLI that cannot publish, before the review starts, rather than
  discovering it at argument parsing.
- Conclude the check run only for a result that names the reviewed revision, and
  only when it is the head this Action resolved. A result that names another
  revision is `superseded`; one that names none is `incompatible-cli`. Neither
  concludes a verdict, because the identity the check run asserts cannot be
  established without it.
- Report the check run against the resolved reviewed head only, and never
  assert a verdict for a head that was not reviewed.
- Treat check-run reporting as optional. A missing permission produces a
  visible warning and never changes the review outcome.

### Data minimization

- Build uploaded artifacts from an explicit allowlist of fields, so a field the
  CLI adds later is dropped until it is added to the documented schema.
- Do not include prompts, source contents, credentials, or debug output.
- Publish a CLI failure message to the check run or the failure notice only for
  an allowlist of failure kinds, each carrying a message composed from a fixed
  sentence and the caller's own input. A kind this revision does not name is
  withheld, whatever its stage, because a failure message can also describe the
  account, the provider, or the review itself. What is published is reduced to a
  single line and truncated, so it cannot carry a payload or escape the code
  span it renders in.

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
