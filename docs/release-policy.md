# Release policy

Releases follow semantic versioning. Breaking Action-contract changes require
a new major version. Compatible fixes and features use minor or patch
releases.

A release is cut by dispatching the Release workflow, which:

1. refuses to run from any ref but `main`;
2. refuses to tag a head whose validation checks are not all green;
3. creates the tagged GitHub release at main's head, with the release notes
   stating the full commit SHA to pin and the CLI version the revision
   installs.

Tags are immutable: one release per tag, never moved and never re-pointed. A
dispatch naming an existing tag fails, and that failure is the policy working.
There are no moving version tags; the supported reference for a caller is
always the release commit SHA quoted in the notes, which is also what the
setup plugin resolves and pins. Making a new release the Marketplace-listed
version is a manual checkbox on the release page.

## Pre-release validation against an unreleased CLI

Integration happens on `main` itself: the monorepo's caller rides
`tesslio/code-review-action@main` with the internal `cli-channel: head`
input, so every merged change here is exercised against the newest merged
Tessl CLI on real pull requests before any release includes it. Neither the
moving `main` ref nor `cli-channel` is a supported reference or input for
external callers: the supported references are the release commit SHAs
described above.
