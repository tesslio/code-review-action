# Tessl Code Review

Run Tessl Code Review in GitHub Actions and publish one native pull-request
review.

The Action handles pull-request resolution, exact-head checkout, Tessl CLI
setup, review publication, stale-head protection, idempotency, failure notices,
and result artifacts. Your workflow retains control of triggers, concurrency,
permissions, secrets, runners, timeouts, and branch protection.

## Quick start

Store a Tessl API token as the `TESSL_TOKEN` repository secret, then add this
workflow:

```yaml
name: Tessl Code Review

on:
  pull_request:
    types: [opened, reopened, ready_for_review]

permissions:
  contents: read
  checks: write
  issues: write
  pull-requests: write

concurrency:
  group: tessl-code-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: tesslio/code-review-action@<full-commit-sha>
        with:
          tessl-token: ${{ secrets.TESSL_TOKEN }}
```

Pin the Action to a full commit SHA. A release's notes provide the SHA to use.
The Action checks out the pull-request head itself, so the calling job does not
need a separate checkout step.

For the full setup walkthrough, gate configuration and repository settings,
security posture, update and removal procedures, and troubleshooting, see
[Set up Tessl Code Review](https://docs.tessl.io/tutorials/setting-up-agentic-code-review).

## Configuration

The default configuration runs the `standard` profile in advisory mode.

```yaml
- id: review
  uses: tesslio/code-review-action@<full-commit-sha>
  with:
    tessl-token: ${{ secrets.TESSL_TOKEN }}
    profile: standard
    mode: advisory
    lenses: >-
      ["tessl/code-review@0.0.3#review-security-and-privacy","tessl/code-review@0.0.3#review-correctness-and-data-integrity"]
```

Passing `lenses` replaces the profile's default lens selection with the exact
ordered JSON array. A review supports at most 8 lenses. Pin registry
references so the review does not change when a plugin publishes a new
version. The selected profile owns review implementation details, which are
not supported customer workflow configuration.

See [Action contract](docs/action-contract.md) for supported customer
configuration and outputs.

## Review cadence

The quick-start workflow reviews a pull request when it opens, reopens, or
leaves draft. The Action also supports comment-driven and manually dispatched
runs, and it resolves the current head itself for each of them, so a review
always covers the latest commit rather than the one that opened the pull
request. The workflows below can be added alongside the quick start or instead
of it.

### Re-review when it is requested

Every published review closes by asking for a mention once fixes or replies are
ready. `@tessl-code-review` is text in a comment rather than a GitHub account,
so recognizing it is the workflow's job:

```yaml
name: Tessl Code Review (requested)

on:
  issue_comment:
    types: [created]

permissions:
  contents: read
  checks: write
  issues: write
  pull-requests: write

concurrency:
  group: tessl-code-review-${{ github.event.issue.number }}
  cancel-in-progress: false

jobs:
  review:
    if: >-
      github.event.issue.pull_request != null &&
      github.event.issue.state == 'open' &&
      contains(github.event.comment.body, '@tessl-code-review') &&
      contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: tesslio/code-review-action@<full-commit-sha>
        with:
          tessl-token: ${{ secrets.TESSL_TOKEN }}
```

The `author_association` condition is the actor check, and it is the caller's
responsibility. An `issue_comment` run holds the repository write permissions
and the `TESSL_TOKEN` secret, and anyone who can comment on a pull request can
start one, so without a condition of this kind an outside commenter can spend
the token at will. Tighten the list to suit the repository, or replace it with a
step that queries the commenter's permission level. The `issue.state` condition
keeps a stray mention on a closed or merged pull request from starting a run
that can only fail. `cancel-in-progress: false` keeps a requested review from
being canceled by the next request.

The concurrency group is the same one the every-commit workflow below uses, so
a repository running both never has two runs publishing for the same pull
request at once. Sharing it means a push cancels a requested run that is still
in flight for the head it replaced, and a mention arriving during a push-driven
run queues behind it rather than racing it.

### Review every commit

```yaml
name: Tessl Code Review

on:
  pull_request:
    types: [opened, reopened, ready_for_review, synchronize]

permissions:
  contents: read
  checks: write
  issues: write
  pull-requests: write

concurrency:
  group: tessl-code-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: tesslio/code-review-action@<full-commit-sha>
        with:
          tessl-token: ${{ secrets.TESSL_TOKEN }}
```

`synchronize` fires on every push to the pull-request branch. Per-pull-request
`cancel-in-progress: true` means the next push cancels the review already
running for the previous head instead of racing it, which also avoids paying
for reviews that would end up superseded.

### Review on demand

A `workflow_dispatch` job passes the pull-request number through the `pr-number`
input, which is the same input any event without pull-request context uses.

## Advisory and gate modes

Advisory mode is the default. It publishes a `COMMENT` review and succeeds for
every valid review outcome, including outcomes with findings.

Gate mode connects the review outcome to the check result:

- An approved review attempts to approve the pull request and succeeds.
- A review that requires changes attempts to request changes, publishes the
  complete review, and fails the check.
- If GitHub does not permit the requested review event, the Action publishes
  the completed review as a comment, explains the repository configuration
  problem, and fails the check.
- If the review returns no approval verdict, the gate is not established and
  the check fails. Only a boolean verdict approves a commit, so a missing or
  malformed one fails closed rather than passing the commit through. Such an
  outcome cannot be published either, and gate mode reports the missing verdict
  rather than the publication failure it causes.

Approval also requires the repository setting that allows GitHub Actions to
create and approve pull requests.

## The Tessl Code Review check

The Action reports its own check run, named `Tessl Code Review`, against the
pull-request head it reviewed. Require that name in branch protection when you
enforce gate mode.

Requiring the calling workflow's job instead only enforces on `pull_request`
runs. A comment-driven or manually dispatched run is associated with the
default branch, so its job status never lands on the pull request and the
required check never arrives. The Action resolves the reviewed head itself, so
its check run lands on that head whatever the trigger was.

Conclusions:

| Terminal status | Gate mode | Advisory mode |
| --- | --- | --- |
| Changes approved | success | success |
| Findings reported | not reachable | neutral |
| Changes requested | failure | not reachable |
| Review or publication did not complete | failure | neutral |
| Repository settings blocked the review event | failure | not reachable |
| Review verdict missing | failure | not reachable |
| Superseded by a newer commit | neutral | neutral |

Advisory mode never concludes failure, so requiring the check while running
advisory cannot turn advisory into a gate. What the advisory check tells you is
whether the review reached a verdict, not whether the run was healthy: a run
that broke reports neutral, and the breakage reaches you as a failed job and a
pull-request comment.

### Superseded runs

If the pull-request head moves while the review is running, the Action publishes
nothing for the head it reviewed. The job fails with exit code 1 so that an
unpublished review cannot read as a completed one, the `status` output is
`superseded`, and the check concludes neutral in both modes because the reviewed
head got no verdict and the commit that replaced it was never judged. The
workflow run carries a warning naming the reason, and the check-run output
repeats it.

Nothing needs fixing. The push that superseded the run is a new head, and a run
against that head reviews it. If your triggers do not cover that push, re-run
the workflow for the current head.

The conclusions assume `neutral` does not block a required check. Confirm that
against the branch protection or ruleset your repository uses before requiring
the check.

The check run needs the `checks: write` permission. A workflow that does not
grant it behaves exactly as before and logs a warning naming the missing
permission. Nothing else about the run changes.

A run killed before it finalizes, by a job timeout or a lost runner, leaves the
check `in_progress`, which holds a pull request that requires it. Re-run the
workflow to replace it.

## Using outputs

Later steps in the same job can consume the Action's structured result:

```yaml
- id: review
  uses: tesslio/code-review-action@<full-commit-sha>
  with:
    tessl-token: ${{ secrets.TESSL_TOKEN }}

- if: always()
  run: echo "Review status: ${{ steps.review.outputs.status }}"
```

The Action also uploads a versioned result artifact. Uploaded data is built
from an explicit field allowlist and excludes credentials, source contents,
prompts, and debug output. See
[Public artifact schema](docs/action-contract.md#public-artifact-schema) for the
published fields.

## Limits and security

- Cross-repository pull requests are rejected before review execution.
- The Action does not execute code from the reviewed checkout.
- Pull-request content and repository files are treated as untrusted input.
- The automatic GitHub token is used for review publication.
- Callers must grant the permissions shown in the quick-start example.

Read [Security model](docs/security-model.md) before adding comment-driven or
other privileged triggers.

## Updating or removing the Action

To update, replace the pinned commit SHA after reviewing the target release
notes. To remove Tessl Code Review, delete the calling workflow and remove the
`TESSL_TOKEN` repository secret. Also remove its required check from branch
protection if gate mode was enabled.

## Development

```bash
bash scripts/validate-foundation.sh
```

## Security

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## License

MIT
