# Agent Instructions

Instructions for AI coding agents (and contributors) working in this repository.

## Changelog

This project keeps a [`CHANGELOG.md`](./CHANGELOG.md) following the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

- **Always update `CHANGELOG.md` under `[Unreleased]`** when a change affects users of the
  pi-tgrep extension: new features, behavior changes, configuration changes, bug fixes, or
  removals.
- **Always focus on the user-facing parts.** Describe what changed for someone installing or
  using pi-tgrep (new tool behavior, a new environment variable, a fixed bug a user could hit,
  a changed default) — not internal refactors, implementation details, or test-only changes.
  Skip the changelog entry entirely for changes that have no observable effect on users.
- Use the existing `Added` / `Changed` / `Fixed` / `Removed` subsections under `[Unreleased]`,
  creating them as needed.
- Do not add a new version heading yourself; release automation moves `[Unreleased]` into a
  dated version section when a release is cut.

## Releasing

Releases are cut by pushing a `v*.*.*` tag, which triggers
[`.github/workflows/publish.yml`](./.github/workflows/publish.yml). That workflow verifies the
tag matches `package.json`, runs typecheck/tests, publishes to npm, and creates a GitHub release
using the matching `CHANGELOG.md` section.
