# Release guide

Packages are versioned independently. The agent owns the release end to end: it
bumps `package.json`, writes the `CHANGELOG.md` entry by hand, and pushes a
component tag. Pushing the tag runs [`.github/workflows/release.yml`](../.github/workflows/release.yml),
which creates the GitHub release from the changelog and publishes the package to
npm with trusted publishing (OIDC).

## Tag format

Component tags use `<package-directory>-v<version>`, for example
`pi-web-search-v0.5.0`. The release name uses the package directory (the short
name, for example `pi-web-search`), not the scoped npm name
(`@zeldrisho/pi-web-search`).

## Changelog format

Each `CHANGELOG.md` follows [Keep a Changelog 2.0.0](https://keepachangelog.com/en/2.0.0/):
a `# Changelog` header, an `## [Unreleased]` section at the top, version headings
of the form `## [version] - YYYY-MM-DD` whose `[version]` resolves to a comparison
link defined once at the bottom of the file, and the six standard `###` sections
(`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`). Run
`vp run format:changelog` to normalize an entry after writing it by hand.

The changelog section for the released version becomes the GitHub release notes.
`scripts/release.ts notes <package> <file>` extracts that section.

Each package owns its own `CHANGELOG.md`, so do not repeat the package name as a
bullet scope: write `- Add …`, not `- **web-fetch:** Add …`. Keep a scope only
when it adds meaning beyond the file, for example `**deps:**` or `**security:**`.

## Release procedure

1. Confirm the package and expected version with the repository owner.
2. Bump `version` in `packages/<name>/package.json`.
3. Add a `## [version] - YYYY-MM-DD` entry to `packages/<name>/CHANGELOG.md` and run `vp run format:changelog`.
4. Run `vp run validate` on the change, then open and merge a pull request.
5. Confirm the package and version **before** creating the tag. The `publish` environment is declared for OIDC trusted publishing and provenance, but in this repository it does **not** require a manual approval, so pushing the tag publishes to npm automatically (to add a manual gate, configure required reviewers on the `publish` environment).
6. From `main`, create and push the component tag: `git tag <name>-v<version> && git push origin <name>-v<version>`.
7. Confirm CI, the component tag, the GitHub release, OIDC publication, provenance, npm metadata, and tarball contents.

If a tag run fails after its GitHub release was already created, it leaves a partial
release. First check whether the version already exists on npm with `npm view
<package>@<version>`. npm permanently reserves a published `name@version` pair and
rejects a second publish, so if the version is present, reconcile the existing GitHub
release and provenance and escalate rather than republishing. If the version is
absent, delete the GitHub release and the remote tag, then re-create and push the tag
at the corrected commit; the run republishes automatically.

## Bootstrap a new npm package

npm trusted publishing cannot publish a package's first registry version. This is
a [known npm limitation](https://github.com/npm/cli/issues/8544). Before merging a
new package to `main`, publish a one-off `0.0.0` with `--tag bootstrap` from an
inspected local tarball (do not commit the bootstrap version), then configure the
package's npm trusted publisher for repository `zeldrisho/pi-packages`, workflow
`release.yml`, environment `publish`, with the `npm publish` action allowed. After
the package change merges, treat its first tracked version as a normal release:
write the changelog entry, bump the manifest, and push its component tag.

Publishing the bootstrap version is irreversible. Stop if any name, version,
access level, tarball content, or publisher setting is unexpected.

## Invariants

- Keep each package manifest, component tag, GitHub release, npm version, and changelog synchronized for the same version.
- The agent writes all changelog entries by hand; the workflow only reads them.
- Pushing the component tag publishes automatically via the `publish` environment (OIDC trusted publishing). The environment is configured for provenance only and does not currently require a manual approval, so confirm the package and version are correct before pushing the tag.
- Rebase work branches onto their target; never merge the target into them.
- Verify npm trusted publication end to end after every release.

## Escalation conditions

Pause the release and notify the repository owner if the manifest version, tag,
package path, or changelog disagree; or authentication, OIDC, provenance, or
publication fails.
