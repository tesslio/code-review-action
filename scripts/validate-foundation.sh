#!/usr/bin/env bash

set -euo pipefail

required_files=(
  AGENTS.md
  CONTRIBUTING.md
  LICENSE
  README.md
  SECURITY.md
  .github/CODEOWNERS
  .github/dependabot.yml
  docs/architecture.md
  docs/release-policy.md
  docs/action-contract.md
  docs/security-model.md
)

for file in "${required_files[@]}"; do
  if [[ ! -s "$file" ]]; then
    echo "missing or empty required file: $file" >&2
    exit 1
  fi
done

if [[ ! -s action.yml ]]; then
  echo "missing or empty supported Action entry point: action.yml" >&2
  exit 1
fi

# A reference to this repository's own Action is not third-party code, so the
# rule skips it: the workflow that reviews this repository takes the moving
# major tag the README recommends to every caller.
if grep -rnE 'uses:[[:space:]]+[^./][^@[:space:]]+@(main|master|latest|v[0-9]+([.][0-9]+)*)' .github/workflows action.yml \
  | grep -vE 'uses:[[:space:]]+tesslio/code-review-action@v[0-9]+$'; then
  echo "third-party Actions must be pinned by full commit SHA" >&2
  exit 1
fi

node --test test/*.test.mjs

git diff --check
