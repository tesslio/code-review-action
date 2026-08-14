# Action contract

The supported entry point is `action.yml`.

## Inputs

| Input | Required | Behavior |
| --- | --- | --- |
| `tessl-token` | yes | Authenticates the Tessl CLI. |
| `profile` | no | Named review profile. Defaults to `standard`. |
| `lenses` | no | JSON array containing the complete ordered lens selection, at most 5 entries. Empty uses profile defaults. |
| `mode` | no | `advisory` or `gate`. Defaults to `advisory`. |
| `pr-number` | no | Open pull-request number for an event without pull-request context. |

## Outputs

| Output | Purpose |
| --- | --- |
| `status` | Terminal review status. |
| `head-sha` | Exact reviewed pull-request head. |
| `review-id` | Created or reused GitHub review ID, when available. |
| `result-path` | Structured CLI result for later steps in the same job. |
| `publication-path` | Publication receipt for later steps in the same job. |
| `result-artifact` | Name of the uploaded result artifact. |

The uploaded artifact contains the review outcome, selected configuration,
duration, and publication receipt. It does not include credentials, source
contents, prompts, or debug output.

The outcome uses `approved` for the overall decision and `requiresChanges` for
each finding's effect on that decision.

## Public artifact schema

The artifact is built from a field allowlist. A field the CLI produces that is
not listed here is dropped, so a new CLI field reaches the artifact only when it
is added to the allowlist and to this table.

| Path | Fields |
| --- | --- |
| root | `schemaVersion`, `status`, `outcome`, `failure`, `diagnostics`, `configuration`, `publication` |
| `outcome` | `schemaVersion`, `runId`, `profileName`, `model`, `effort`, `judgement`, `approved`, `subject`, `findings`, `reconciliation` |
| `outcome.subject` | `schemaVersion`, `repository`, `change` |
| `outcome.subject.change` | `baseRevision`, `headRevision`, `headKind` |
| `outcome.findings[]` | `id`, `title`, `body`, `severity`, `requiresChanges`, `disposition`, `lensRefs`, `reason`, `location`, and the flat location form `path`, `line`, `side` |
| `outcome.findings[].location` | `path`, `line`, `side` |
| `outcome.reconciliation[]` | `category`, `title`, `note`, `findingId`, `priorFindingId` |
| `failure` | `kind`, `message` |
| `diagnostics` | `durationMs` |
| `configuration` | `profile`, `model`, `effort`, `lenses` |

`configuration.model` and `configuration.effort` record the resolved values the
run used, normally the selected profile's. They are observability, not an input
contract.

Finding evidence is deliberately absent: it can quote the reviewed source, which
the artifact does not carry.

`publication` is the Action's own receipt rather than CLI output, and it is
recorded as produced.

## Comment protocol

The published review body carries HTML comment markers. Most are internal: the
Action uses them to find its own review, thread, and replies across runs. One is
a supported contract for a consumer that reads the review over the GitHub API
rather than from the run that produced it.

```
<!-- tessl-code-review:result:v1 approved=false findings-total=4 findings-unplaced=1 -->
```

| Field | Value |
| --- | --- |
| `approved` | Exactly `true` or `false`. The same `outcome.approved` the verdict heading is rendered from. |
| `findings-total` | Every finding the review reports this round, including any continuing on a thread from an earlier round. |
| `findings-unplaced` | How many of those no inline thread carries, for any reason. |

Guarantees:

- Exactly one `result:v1` marker per published review body. Model-authored text
  reaches the same body, so the marker prefix is neutralized in every such
  string before it is interpolated. A quoted marker is published as visible
  text, not as a comment.
- Present on every published review, including one that reports no findings. Its
  presence on a head means a review was published for that head.
- Counts are always stated. A zero is emitted as `0` and never omitted.
- `findings-unplaced` is never greater than `findings-total`.
- A finding continuing on a thread opened by an earlier round is carried, so it
  is not unplaced. When GitHub rejects the inline locations and the findings are
  rendered into the body instead, they are unplaced.

Format:

- Version lives in the key. A consumer matches `result:v1` and rejects an
  unrecognised version without parsing it.
- Bare space-separated `key=value` in kebab-case, as every marker in this
  vocabulary is written. Values are never quoted, never empty, and never contain
  whitespace or `>`.
- Booleans and integers are written literally. A future string-valued field is
  percent-encoded, as `lenses:v1` refs are, which puts `-->` out of reach inside
  a value.
- One line. Neither field order nor the marker's position within the body is
  contract.
- Fields may be added under `v1`. Removing a field, or changing what one means,
  bumps the version.

A run that fails before publishing a review publishes no review, so no
`result:v1` marker. It posts a pull-request comment carrying
`tessl-code-review:failure:v1` instead, and the Action reports the failure
through the check run and the job conclusion.

Every other marker — `run:v1`, `workflow-run:v1`, `failure:v1`, `lenses:v1`,
`finding:v1`, `reconciliation:v1` — is internal and may change without a version
bump.

## Review modes

In advisory mode, a valid result publishes a `COMMENT` review and findings do
not fail the job.

In gate mode, an approved result attempts `APPROVE`. A result that requires
changes attempts `REQUEST_CHANGES` and then fails the check. If repository
settings do not allow the requested review event, the Action publishes the
completed review as a comment, explains the configuration problem, and fails
the gate.

Gate mode fails closed. Only a boolean `approved` decides the gate: an outcome
that omits the verdict, or carries a non-boolean in its place, is reported as
`gate-verdict-failure` and fails the check rather than passing a head that
nothing judged. Such an outcome also fails publication, and gate mode reports
the missing verdict in preference to `publication-failure` because it is the
more specific diagnosis. A publication that fails for any other reason is
reported as `publication-failure`, verdict or not, because nothing was
published. Advisory mode is unaffected, and treats anything other than boolean
`true` as findings reported.

## Check run

The Action reports one check run named `Tessl Code Review` against the
pull-request head it resolved. The name is part of the contract. Branch
protection requiring gate mode must require that name, because it is the only
check this Action reports on the reviewed head for a comment-driven or manually
dispatched run.

The check run opens as `in_progress` once the head is resolved and completes
with the terminal status:

`approved` is the terminal success status, matching the outcome decision.

| Terminal status | Gate conclusion | Advisory conclusion |
| --- | --- | --- |
| `approved` | success | success |
| `advisory-findings` | not reachable, neutral | neutral |
| `changes-requested` | failure | not reachable, neutral |
| `technical-failure` | failure | neutral |
| `publication-failure` | failure | neutral |
| `gate-configuration-failure` | failure | not reachable, neutral |
| `gate-verdict-failure` | failure | not reachable, neutral |
| `superseded` | neutral | neutral |

Advisory mode never concludes failure, so requiring the check cannot turn
advisory mode into a gate. Breakage still reaches maintainers as a failed job
and a pull-request comment; the advisory check reports whether the review
reached a verdict, not whether the run was healthy.

A result file that cannot be read, is empty, or is not valid JSON is the review
failing rather than the publication failing, so the terminal status is
`technical-failure`, which concludes the check as a failure in gate mode and as
neutral in advisory mode. The run carries an error annotation naming the file
and the problem.

`advisory-findings` is an advisory status: gate mode decides an outcome with
findings as `approved` or `changes-requested`, and an outcome without a boolean
verdict as `gate-verdict-failure`.

### Superseded runs

A run is superseded when the pull-request head moves between the review and its
publication. The Action publishes no review for the head it reviewed, because
that head is no longer the one the pull request points at.

- Job conclusion: failure, exit code 1. The job fails so that an unpublished
  review is never mistaken for a completed one.
- Check conclusion: neutral in both modes. The reviewed head got no verdict, and
  the Action asserts nothing about the head that replaced it.
- Terminal status output: `superseded`.
- The workflow run carries a warning annotation naming the reason, and the check
  run output repeats it.

The caller does not need to do anything. The push that superseded the run is
itself a new head, and a run against that head reviews it. If the workflow does
not trigger on that push, re-run it for the current head.

Both rest on `neutral` not blocking a required check. Confirm that against the
branch protection or ruleset the repository actually uses before requiring the
check.

Cross-repository pull requests are rejected before the check run is created.

A run that is killed before it finalizes, by a job timeout or a lost runner,
leaves the check run `in_progress`. Re-run the workflow to replace it: a later
check run of the same name supersedes the abandoned one.

## Permissions

| Permission | Level | Purpose |
| --- | --- | --- |
| `contents` | read | Resolve and check out the exact pull-request head. |
| `checks` | write | Report the review result on the reviewed head. |
| `pull-requests` | write | Publish a native pull-request review. |
| `issues` | write | Publish and clear visible failure notices. |

Without `checks: write`, the Action logs a warning naming the missing
permission and completes as it otherwise would. No other behavior depends on
the check run.

The Action uses GitHub's automatic token for publication.
