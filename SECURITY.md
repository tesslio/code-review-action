# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use this repository's
private vulnerability-reporting form and include the affected revision,
reproduction steps, and potential impact.

## Supported versions

Security fixes apply to the latest supported major release.

## Action security

The Action processes untrusted pull-request content. Changes must preserve the
controls in [Security model](docs/security-model.md), including exact-head
pinning, trusted support code, minimal permissions, secret isolation, and
artifact data minimization.
