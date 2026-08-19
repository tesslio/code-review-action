# Release policy

Releases follow semantic versioning. Breaking Action-contract changes require
a new major version. Compatible fixes and features use minor or patch
releases.

A release is cut by dispatching the Release workflow, which:

1. refuses to run from any ref but `main`; and
2. creates the tagged GitHub release at main's head, with the release notes
   stating the full commit SHA to pin, read from the tagged commit. The notes
   name no CLI version: the Action installs the current release rather than a
   pinned one, so no version is fixed at the moment of the cut.

Nothing at release time checks that the head is green, because nothing at
release time needs to: the validation jobs are required status checks on
main, so a pull request cannot merge while they are red and main's head is
green by construction. Enforcement sits at merge time, where blocking is
routine and the remedy is obvious, rather than at release time, where it
would be a machine veto over a human decision.

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
