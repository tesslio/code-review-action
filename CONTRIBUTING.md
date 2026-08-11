# Contributing

## Before making a change

1. Read [AGENTS.md](AGENTS.md).
2. Confirm the change belongs to the GitHub Action boundary.
3. Update contract and security documentation with interface changes.

## Pull requests

- Use Conventional Commits.
- Explain compatibility and security implications.
- Pin third-party Actions by full commit SHA.
- Keep permissions explicit and minimal.
- Run `bash scripts/validate-foundation.sh`.

The repository uses squash merges and deletes merged branches.
