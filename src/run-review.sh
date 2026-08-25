#!/usr/bin/env bash

set -euo pipefail

result_path="${RUNNER_TEMP}/tessl-code-review-result.json"
public_artifact_path="${RUNNER_TEMP}/tessl-code-review-public-result.json"
artifact_name="tessl-code-review-${HEAD_SHA}"

{
  echo "result-path=${result_path}"
  echo "artifact-path=${public_artifact_path}"
  echo "artifact-name=${artifact_name}"
} >> "$GITHUB_OUTPUT"

args=(--pr "$PR_NUMBER" --profile "$PROFILE")
if [[ -n "$MODEL" ]]; then
  args+=(--model "$MODEL")
fi
if [[ -n "$EFFORT" ]]; then
  args+=(--effort "$EFFORT")
fi
# Trimmed and empty-skipped the same way the input validation reads them, so a
# formatted list and a bare one send the same arguments. The inferred approver
# joins the caller's list rather than replacing it, and is deduplicated against
# it because a caller that also named it must not send the same login twice.
# GitHub logins are case-insensitive, so the comparison is too.
declare -a approver_logins=()
seen_approvers=""
add_approver() {
  local candidate="$1"
  candidate="${candidate#"${candidate%%[![:space:]]*}"}"
  candidate="${candidate%"${candidate##*[![:space:]]}"}"
  [[ -n "$candidate" ]] || return 0
  local folded
  folded="$(tr '[:upper:]' '[:lower:]' <<< "$candidate")"
  [[ "$seen_approvers" != *"|${folded}|"* ]] || return 0
  seen_approvers="${seen_approvers}|${folded}|"
  approver_logins+=("$candidate")
}
if [[ -n "${APPROVER_LOGINS:-}" ]]; then
  while IFS= read -r approver_login; do
    add_approver "$approver_login"
  done < <(tr ',' '\n' <<< "$APPROVER_LOGINS")
fi
add_approver "${INFERRED_APPROVER:-}"
for approver_login in ${approver_logins[@]+"${approver_logins[@]}"}; do
  args+=(--approver "$approver_login")
done
if [[ -n "$LENSES" ]]; then
  if ! jq -e 'type == "array" and all(.[]; type == "string" and length > 0)' <<< "$LENSES" >/dev/null; then
    echo "::error::lenses must be a JSON array of non-empty strings."
    echo "exit-code=2" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  while IFS= read -r lens; do
    args+=(--skill "$lens")
  done < <(jq -r '.[]' <<< "$LENSES")
fi

# Advisory publishes a review that neither approves nor blocks; gate publishes
# the verdict the review reached. The verdict itself is the CLI's to resolve,
# because it does not exist until the review has run.
case "$MODE" in
  advisory) args+=(--publish comment) ;;
  gate) args+=(--publish verdict) ;;
  *)
    echo "::error::mode must be advisory or gate."
    echo "exit-code=2" >> "$GITHUB_OUTPUT"
    exit 0
    ;;
esac

set +e
tessl code review "${args[@]}" --json > "$result_path"
code="$?"
set -e

echo "exit-code=$code" >> "$GITHUB_OUTPUT"

# A successful no-match result is terminal and non-publishable. Expose only
# that fixed state; never copy the CLI's reason or reviewed content into output.
if [[ "$code" == "0" ]] && jq -e '.status? == "skipped" and .reason? == "no-matching-lenses"' "$result_path" >/dev/null 2>&1; then
  echo "result-status=skipped" >> "$GITHUB_OUTPUT"
fi

# The published review's identifier, read back from the CLI's receipt so the
# Action's declared output survives publication moving into the CLI. Exported
# only for a receipt that names a review actually on the pull request: a
# superseded or failed publication carries no review to point at, and the
# identifier is checked rather than trusted because the CLI version producing it
# is the caller's to choose.
review_id="$(jq -r '
  select(.publication.status == "published" or .publication.status == "reused")
  | .publication.reviewId // empty
' "$result_path" 2>/dev/null || true)"
if [[ "$review_id" =~ ^[1-9][0-9]*$ ]]; then
  echo "review-id=${review_id}" >> "$GITHUB_OUTPUT"
fi

exit 0
