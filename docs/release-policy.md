# Release policy

Releases follow semantic versioning. Breaking Action-contract changes require
a new major version. Compatible fixes and features use minor or patch releases.

Release preparation must:

1. verify the Action contract and regression suite;
2. create an immutable release commit and annotated version tag;
3. publish compatibility and migration notes when needed; and
4. record a known-good rollback revision.

Examples use full commit SHAs. Major-version tags may be offered as a
convenience, but they are moving references.

## Canary

The long-lived `canary` branch carries the smallest possible overlay needed to
select the Tessl CLI head channel. After a successful validation run on
`main`, automation validates the prospective merge and merges `main` into
`canary` through a pull request. Conflicts stop synchronization for manual
resolution; the branch is never force-pushed or recreated.

The `canary` branch exists for pre-release validation of the Action against an
unreleased Tessl CLI. It is not a supported reference for callers: the
supported references are the release commit SHAs described above.
