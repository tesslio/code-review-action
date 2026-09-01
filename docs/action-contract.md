# Action contract

The supported entry point is `action.yml`.

## Inputs

| Input | Required | Behavior |
| --- | --- | --- |
| `tessl-token` | yes | Authenticates the Tessl CLI. |
| `github-token` | no | Token whose identity authors the published review. Defaults to the workflow's own token, which publishes as `github-actions[bot]`. A GitHub App installation token or a machine-user token publishes under that identity instead, and needs pull-requests write and contents read on this repository. Contents write is optional: GitHub gates thread reopening behind it, so an identity holding contents write reopens a resolved thread that still carries a finding requesting changes, rather than republishing that finding as a new comment. Reopening is the only review behavior it adds; the grant itself is GitHub's general write access to repository content. Checked before the review starts for whether it can reach the repository at all, not for whether it may review: GitHub exposes no pre-flight answer to the second, and the nearest signal describes content write rather than pull-request write. The Action's own plumbing keeps the workflow token whatever this is set to. |
| `profile` | no | Named review profile or repository `.yml` or `.yaml` profile path. Defaults to `standard`; file profiles are not discovered automatically. |
| `lenses` | no | JSON array containing the complete ordered lens selection, at most 8 entries. Empty uses profile defaults. |
| `effort` | no | Reasoning effort for every review lens: `low`, `medium` or `high`. Overrides any effort the profile sets, including a per-lens one. Empty sends none, leaving the installed CLI to resolve it from the profile and the model's own default. A value outside the three is rejected before the review starts. |
| `mode` | no | `advisory` or `gate`. Defaults to `advisory`. |
| `pr-number` | no | Open pull-request number for an event without pull-request context. |
| `approver-logins` | no | Comment-author logins whose comments may request an approval, for example `kikimora-dev[bot]`, separated by commas or newlines. Empty permits none. A named login is admitted whatever `allowed-associations` says, for a review as well as an approval — see below. |
| `allowed-associations` | no | Comma-separated GitHub author associations whose comments may request a review, for example `OWNER,MEMBER,COLLABORATOR`. Empty accepts any author. Applies to comment events only; a comment from any other association is not a request and nothing runs. The pull request's own author is never refused, whatever the list says — see below. |
| `cli-version` | no | Tessl CLI version to install. Defaults to `latest`, which tracks the current release; set an exact version to fix the CLI alongside the Action's own commit SHA. The selected release must publish a review and report the revision it reviewed; one that does not concludes `incompatible-cli`. |

## Who decides what

A caller declares which events reach the workflow, grants the permissions, and
sets its own concurrency. It also carries a coarse `if:` so GitHub does not start
a runner for every comment in the repository — a workflow expression cannot match
a token boundary, so that filter is loose on purpose.

Everything after that is the Action's. Whether a comment is a request for a review
is decided here, once, from the comment body and the author's association: the
handle must appear as a whole token, case-insensitively, and in the comment's own
voice. Fenced blocks, quoted lines and inline code spans come out of the body
first, so `@tessl-code-reviewer` is not a request and neither is the handle inside
backticks or behind a `>`. A caller does not implement that rule and cannot
disagree with it.

`allowed-associations` has one exemption: the pull request's own author is always
allowed to request a review of it. That is a policy statement — an author already
decides what the pull request contains, so refusing their request protects
nothing — and it is also a defence against GitHub's own value. The association in
a `pull_request_review_comment` payload reports the author of the branch's commits
as `CONTRIBUTOR`, where the same person on the same pull request is `MEMBER` in an
`issue_comment` payload and in the REST API. Without the exemption, a list of
`OWNER,MEMBER,COLLABORATOR` silently refused an author's inline requests on their
own pull request.

Read `allowed-associations` as "who else may ask", and treat the association as a
coarse signal rather than an authorization boundary: it is what the event payload
says, not a permission lookup.

`approver-logins` answers a different question. A comment can ask the reviewer to
approve the pull request outright rather than review it, and the CLI grants that
to the repository's own members by association. A GitHub App has no such
association — it comments as `NONE` whatever its permissions — so naming its login
here is the only way one can ask. A login is matched case-insensitively, and
exactly as the event payload spells it, which for an App includes the `[bot]`
suffix.

A named login is admitted past `allowed-associations` as well. Otherwise the
two inputs contradict each other in exactly the case they exist for: an App
comments as `NONE`, so an allowlist of human associations would refuse the App
the caller just named — and refuse it as "no review requested", so it would get
neither the approval it asked for nor the refusal explaining why not.

That admission covers an ordinary review request from the same login, not only
an approval. Naming a login says it may ask for the stronger of the two, and
permitting that while refusing the weaker one would contradict itself. So
`approver-logins` widens who may request a review, and a caller tightening
`allowed-associations` should read the two together rather than as separate
gates.

Being named grants nothing on its own: the comment still has to ask for an
approval, and one that asks for a review gets a review.

One login is added to the list without being named: the pull request's own
author, when that author is a GitHub App. An agent that opens a pull request,
pushes fixes and then asks for approval is already admitted, because a pull
request's author is never refused — and was then silently downgraded to a
review, because its login never reached the approver list. A caller that forgot
the input saw a reviewer that reviews and never approves, with nothing saying
why.

The inference stops at an App deliberately. Extending it to every author would
let a person request approval on their own pull request, which is the loop a
required review exists to prevent.

It adds to the list and never replaces it. An approval may be requested by a bot
other than the one that opened the pull request, and naming those stays the
caller's to do. A login named by the caller and inferred as well is sent once.

A request from an author who is not named is refused, and **no review is run**.
Approving is not a review, so reviewing instead would answer a question nobody
asked and spend a full review doing it. The run concludes
`refused-approval-request` — neutral in both modes, because nothing reviewed the
commit and neither passing nor failing it would be true — and the Action posts
one comment saying the request was refused and that commenting
`@tessl-code-review` still gets a review. That comment is the only thing that
reaches the pull request, so a missing allowlist entry reads as a refusal rather
than as a broken reviewer.

Under `gate` a neutral conclusion on a required check holds the pull request
until something reviews the commit. That is the intended position: an unreviewed
commit has not passed.

Whether an approval reaches GitHub at all is `mode`. Under `advisory` the review
is published as a comment whatever it concluded, so an approval granted here
changes nothing on the pull request; `gate` is what publishes the verdict.

An event the Action does not admit ends the run immediately. Nothing is published,
no check run is created, no reaction is posted, and `status` is `not-requested`.
A caller can treat that as success, because refusing to review a comment that did
not ask for one is not a failure.

## Outputs

| Output | Purpose |
| --- | --- |
| `status` | Terminal review status. |
| `head-sha` | Exact reviewed pull-request head. |
| `review-id` | Created or reused GitHub review ID, when available. |
| `result-path` | Structured CLI result for later steps in the same job, including what it published. |
| `result-artifact` | Name of the uploaded result artifact. |

The uploaded artifact contains the review outcome, terminal status and reason,
selected configuration, duration, and publication receipt. It does not include
credentials, source contents, prompts, or debug output.

The outcome uses `approved` for the overall decision and `requiresChanges` for
each finding's effect on that decision.

## Public artifact schema

The artifact is built from a field allowlist. A field the CLI produces that is
not listed here is dropped, so a new CLI field reaches the artifact only when it
is added to the allowlist and to this table.

| Path | Fields |
| --- | --- |
| root | `schemaVersion`, `status`, `reason`, `outcome`, `failure`, `diagnostics`, `configuration`, `publication` |
| `outcome` | `schemaVersion`, `runId`, `profileName`, `model`, `effort`, `judgement`, `approved`, `subject`, `lenses`, `findings`, `reconciliation` |
| `outcome.subject` | `schemaVersion`, `repository`, `change` |
| `outcome.subject.change` | `baseRevision`, `headRevision`, `headKind` |
| `outcome.lenses[]` | `ref`, `effort` |
| `outcome.findings[]` | `id`, `title`, `body`, `severity`, `requiresChanges`, `disposition`, `lensRefs`, `reason`, `location`, and the flat location form `path`, `line`, `side` |
| `outcome.findings[].location` | `path`, `line`, `side` |
| `outcome.reconciliation[]` | `category`, `title`, `note`, `findingId`, `priorFindingId` |
| `failure` | `kind`, `message` |
| `diagnostics` | `durationMs` |
| `configuration` | `profile`, `model`, `effort`, `lenses` |

`outcome.lenses` reports the lens set the run was configured with, each entry
carrying the reasoning effort that lens is configured to run at. A lens that
sends none omits `effort`. Read it as configuration, not as a record of
dispatch: a lens whose globs select nothing is listed here and skipped, so
membership is not evidence the lens ran. Which lenses produced a given finding
is recoverable from that finding's `lensRefs`.

It is distinct from `configuration.lenses`, which echoes the `lenses` input's
explicit selection. `outcome.lenses` describes what the run resolved, whether
that came from the input, a profile, or the default.

A CLI predating the field publishes no `lenses` key at all rather than an empty
array, because the artifact omits absent fields. Treat an absent `lenses` as
"not reported" and an empty array as "a run that resolved no lenses".

`configuration.model` and `configuration.effort` record the resolved values the
run used, normally the selected profile's. They are observability, not an input
contract. The `cli-channel` input is likewise internal: Tessl's own
callers use it to exercise unreleased CLI builds, and it is not supported
customer configuration.

Finding evidence is deliberately absent: it can quote the reviewed source, which
the artifact does not carry.

`publication` is the Action's own receipt rather than CLI output, and it is
recorded as produced.

## Mention acknowledgement

When the run was started by a comment — `issue_comment` or
`pull_request_review_comment` — the Action reacts 👀 to that comment before it
resolves the pull request or reports the check run. A caller needs no step of
its own for this, and passes nothing extra: the Action reads the event's comment
from the workflow context.

Conversation comments and inline review comments have separate reaction
endpoints, and the Action picks the one matching the event.

Acknowledging is best effort. A refused or failed reaction is reported as a run
notice and the review proceeds; nothing about a review depends on it. A run
started by `pull_request` or `workflow_dispatch` has no comment to answer and
reacts to nothing.

A comment the Action does not admit is never acknowledged: the decision described
under "Who decides what" happens first, and a reaction is one of the things it
gates.

## Comment protocol

A review round publishes Markdown from two places. The **CLI** publishes the
review itself: its body, the inline findings, and the replies that reconcile
earlier findings across rounds. The **Action** publishes the check-run summary
and, when a review does not complete, the visible failure notice.

A run that stopped before reviewing anything adds one more sentence to both: the
reason the CLI gave for stopping, quoted inside a code span, so that a profile
naming a file that does not exist is distinguishable from a crashed CLI without
opening the workflow run. It is published only for an allowlist of failures,
named by stage and kind together, whose message is composed from a fixed sentence
and the caller's own configuration — a flag, a path in their profile, a name they
typed. Every other failure keeps the status sentence alone.

The CLI stamps a hidden AI-system notice on the review it publishes, because a
review is a model's output. That is the CLI's behaviour, not this Action's: the
Action neither adds the notice nor verifies that the installed CLI did. The
Action's own bodies carry no marker of their own: a check-run summary is a status
sentence written by hand, optionally followed by a quoted reason the CLI's own
code wrote, and the failure notice is the same pair published precisely when the
model produced nothing. Neither half is model output, and labelling them as such
would make the marker mean less wherever it does appear; it is an HTML comment,
so filtering is the only thing it is for.

The published review body carries HTML comment markers. Most are internal: the
CLI uses them to find its own review, thread, and replies across runs. The other
supported marker is a contract for a consumer that reads the review over the
GitHub API rather than from the run that produced it.

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
  reaches the same body, so the CLI neutralizes the marker prefix in every such
  string before interpolating it. A quoted marker is published as visible text,
  not as a comment.
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
- The `result:v1` marker uses bare space-separated `key=value` fields in
  kebab-case. A value is never quoted, never empty, and never contains whitespace
  or `>`, so every field can be read with one pattern.
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

If no configured lens matches any changed file, the CLI returns a successful
`skipped` result with reason `no-matching-lenses`. No pull-request review or
failure notice is published, and the Action retains the status, reason, diagnostics, and
available configuration in the public artifact, concludes the check `neutral`
in both modes, and succeeds the job. This is not an approval or pass verdict;
in gate mode, the required check does not block the pull request from merging.

In gate mode, an approved result attempts `APPROVE`. A result that requires
changes attempts `REQUEST_CHANGES` and then fails the check while succeeding the
job: the run did what it was asked, and its verdict is reported on the check run
that branch protection requires. If repository settings do not allow the
requested review event, the CLI publishes the completed review as a comment, and
the Action explains the configuration problem and fails the gate.

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

| Terminal status | Gate conclusion | Advisory conclusion | Job |
| --- | --- | --- | --- |
| `approved` | success | success | success |
| `advisory-findings` | not reachable, neutral | neutral | success |
| `changes-requested` | failure | not reachable, neutral | success |
| `technical-failure` | failure | neutral | failure |
| `publication-failure` | failure | neutral | failure |
| `gate-configuration-failure` | failure | not reachable, neutral | failure |
| `gate-verdict-failure` | failure | not reachable, neutral | failure |
| `incompatible-cli` | failure | neutral | failure |
| `superseded` | neutral | neutral | failure |
| `skipped-no-matching-lenses` | neutral | neutral | success |
| `refused-approval-request` | neutral | neutral | success |

The job conclusion reports whether the Action ran, not what the review decided,
and it does not vary by mode. A gate that requests changes ran correctly, so its
job succeeds and the verdict reaches the pull request on the check run. The job
fails when the run could not deliver a review the way it was asked to: it broke,
its head was superseded before publication, or repository settings forced a
complete review into a comment.

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
publication. No review is published for the head that was reviewed, because that
head is no longer the one the pull request points at.

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

## Job summary

Every run that reaches its terminal status writes the review to the workflow
run's job summary.

There are two designs for a review and only two: a **markdown** one and a **CLI
text** one. The job summary is the markdown one, and so is the published
pull-request review body — the two read as one design in two places. The summary
therefore mirrors that body's shape: the verdict heading with the count of
findings requiring changes, the optional-suggestion line when an approving
review still lists findings, the judgement, the severity table ordered
worst-first, one flat `#### Findings` list in the outcome's own order, the
earlier-findings reconciliation, and a link to the published review.

A long review is capped, and the cap prefers what requires changes: an outcome
whose optional findings come first cannot push the finding that caused the
verdict out of the list, which would otherwise leave a requested-changes count
with none of its details on the one surface that stays readable when publication
fails. What is rendered stays in the outcome's own order, and the count of
findings not listed is stated.

It deliberately does **not** group findings into must-fix and suggestions, and
carries no run chips and no lens footer. That grouping is the CLI text design's
alone; adding it here would make the two markdown surfaces disagree about the
most important structural choice either makes.

It is written for a run that published nothing, too. That is the case it exists
for: when publication fails the summary is the only place the completed review
can still be read.

Only `approved`, `advisory-findings` and `changes-requested` present the review
as the verdict for the head under check. Every other outcome-bearing terminal
status — a failed publication, a superseded head, a policy fallback, a gate with
no boolean verdict, a CLI that never reported what it reviewed, and any status a
later revision adds — renders the review with the check run's own explanation
quoted beneath it, so a summary can never contradict the status the check
reports. The revision on the context line comes only from the outcome, never
from the head this Action resolved: a CLI that did not say what it reviewed has
not reviewed that head. A run with no outcome at all writes the status the check
run reports, plus the CLI's reason when there is a publishable one.

The summary never reports what the run cost. Model-authored text reaching it is
bounded, because it is untrusted input on a rendered surface: control characters
and Unicode format characters are removed (bidirectional overrides included, so
displayed text matches stored order), Markdown delimiters are escaped so nothing
model-authored can open a heading, a list, a link, an image or raw HTML, values
rendered inside a code span have their backticks removed, and every value plus
the summary as a whole is length-capped.

Writing the summary is best effort. A failure to write it is a notice; the
review and the check run are unaffected.

## Permissions

These are the workflow token's permissions. An identity supplied as
`github-token` to author the review is a separate token carrying its own
permissions, described under Inputs.

| Permission | Level | Purpose |
| --- | --- | --- |
| `contents` | read | Resolve and check out the exact pull-request head. |
| `checks` | write | Report the review result on the reviewed head. |
| `pull-requests` | write | Publish a native pull-request review, and react to a triggering inline review comment. |
| `issues` | write | Publish and clear visible failure notices, and react to a triggering conversation comment. |

Without `checks: write`, the Action logs a warning naming the missing
permission and completes as it otherwise would. No other behavior depends on
the check run.

The Action uses GitHub's automatic token for publication.
