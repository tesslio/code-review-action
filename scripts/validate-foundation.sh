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
# major tag the README recommends to every caller. The exemption accepts the
# forms YAML allows around that reference — either quote style, and a trailing
# comment — so a rewrapped line does not read as an unpinned dependency.
unpinned=0
while IFS= read -r line; do
  reference="${line#*uses:}"
  reference="${reference#"${reference%%[![:space:]]*}"}"
  reference="${reference%%[[:space:]]*}"
  reference="${reference#[\"\']}"
  reference="${reference%[\"\']}"
  if [[ "$reference" == ./* ]] ||
     [[ "$reference" =~ ^tesslio/code-review-action@v[0-9]+$ ]] ||
     [[ "$reference" =~ ^[^@[:space:]]+@[[:xdigit:]]{40}$ ]] ||
     [[ "$reference" =~ ^docker://[^@[:space:]]+@sha256:[[:xdigit:]]{64}$ ]]; then
    continue
  fi
  echo "unpinned Action reference: $reference" >&2
  unpinned=1
done < <(grep -rhE '^[[:space:]]*(-[[:space:]]+)?uses:' .github/workflows action.yml)
if (( unpinned )); then
  echo "third-party Actions must be pinned by full commit SHA" >&2
  exit 1
fi

node --test test/*.test.mjs

git diff --check
