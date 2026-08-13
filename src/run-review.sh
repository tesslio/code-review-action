#!/usr/bin/env bash

set -euo pipefail

result_path="${RUNNER_TEMP}/tessl-code-review-result.json"
publication_path="${RUNNER_TEMP}/tessl-code-review-publication.json"
public_artifact_path="${RUNNER_TEMP}/tessl-code-review-public-result.json"
artifact_name="tessl-code-review-${HEAD_SHA}"

{
  echo "result-path=${result_path}"
  echo "publication-path=${publication_path}"
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

set +e
tessl code review "${args[@]}" --json > "$result_path"
code="$?"
set -e

echo "exit-code=$code" >> "$GITHUB_OUTPUT"

# A successful no-match result is a terminal, non-publishable result. Expose
# only the small, fixed status vocabulary used by the Action condition; never
# copy the CLI's reason or any reviewed content into GITHUB_OUTPUT.
if [[ "$code" == "0" ]] && result_status="$(jq -r 'if type == "object" and (.status | type == "string") and (.status != "skipped" or .reason == "no-matching-lenses") then .status else empty end' "$result_path" 2>/dev/null)" && [[ "$result_status" =~ ^(ok|skipped|failed)$ ]]; then
  echo "result-status=$result_status" >> "$GITHUB_OUTPUT"
fi
exit 0
