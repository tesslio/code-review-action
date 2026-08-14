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

# A successful no-match result is terminal and non-publishable. Expose only
# that fixed state; never copy the CLI's reason or reviewed content into output.
if [[ "$code" == "0" ]] && jq -e '.status? == "skipped" and .reason? == "no-matching-lenses"' "$result_path" >/dev/null 2>&1; then
  echo "result-status=skipped" >> "$GITHUB_OUTPUT"
fi
exit 0
