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

An exact tag is immutable: one release per exact tag, never moved and never
re-pointed. A dispatch naming an existing exact tag fails, and that failure is
the policy working. The major tag is the one exception, and the section below
states what it means. Making a new release the Marketplace-listed version is a
manual checkbox on the release page.

## Tags

An exact tag — `v1.2.0` — is immutable. It names one commit forever, and a
dispatch naming an existing exact tag fails rather than moving it.

The major tag — `v1` — moves. Cutting a release repoints it at that release's
commit, so a caller on `v1` is on the newest 1.x revision without editing its
workflow. That is the recommended reference, and it is what lets a fix reach a
caller at all: a caller pinned to a commit SHA keeps the revision it pinned until
someone changes it.

A caller that wants immutability pins the exact tag's commit SHA instead, and
accepts that updates need a deliberate bump. Both are supported; only one of them
can be fixed remotely.

## Pre-release validation against an unreleased CLI

Integration happens on `main` itself: the monorepo's caller rides
`tesslio/code-review-action@main` with the internal `cli-channel: head`
input, so every merged change here is exercised against the newest merged
Tessl CLI on real pull requests before any release includes it. Neither the
moving `main` ref nor `cli-channel` is a supported reference or input for
external callers: the supported references are the release commit SHAs
described above.
