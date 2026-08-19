# tesslio repo configuration facts

## Merge gates live in rulesets, not legacy branch protection
`tesslio/code-review-action` (and likely other tesslio repos) has NO legacy
branch protection — `GET /repos/{repo}/branches/main/protection` returns 404
("Branch not protected"). Required status checks are configured via **rulesets**:

- List: `gh api repos/{repo}/rulesets`
- Inspect: `gh api repos/{repo}/rulesets/{id}`
- Update: `gh api --method PUT repos/{repo}/rulesets/{id} --input <json>`

On `code-review-action` there are three rulesets:
- `Prevent Deletions` (org-level, `source_type: Organization`) — don't touch.
- `pr-review` (org-level) — don't touch.
- `code-review-action main validation` (repo-level, id `20854065`) — this is where
  repo-specific required status checks live.

When adding a required check, edit the repo-level ruleset's
`required_status_checks` rule, preserving existing contexts. Do NOT edit
org-level rulesets.

## Tessl Code Review is set up here
- Caller workflow: `.github/workflows/tessl-code-review.yml`, gate mode,
  cadence = PR opened + `@tessl-code-review` mentions (no synchronize).
- Pinned to `tesslio/code-review-action@c6c5070082b1a578993552756e22fe0fef58015b` (v1.1.0).
- Required check name in the ruleset: `Tessl Code Review` (the Action's own check,
  not the caller's `review` job).

## Actions permissions
`can_approve_pull_request_reviews` was already `true` on this repo
(`gh api repos/{repo}/actions/permissions/workflow`). Read before writing —
that PUT also sets `default_workflow_permissions`, so don't blind-PUT it.

## Push is gated by the permission system
`git push` and privileged GitHub API writes (Actions permissions) get denied by
the permission system in this environment even after user go-ahead. Hand the
exact commands to the user rather than retrying indefinitely.
