# Release

Packages are versioned independently. The agent updates the manifest and changelog, then pushes a component tag. The tag triggers [the release workflow](../.github/workflows/release.yml), which creates a GitHub release from the changelog and publishes to npm with trusted publishing (OIDC).

## Normal release

A release starts by confirming the package and version, then updating
`packages/<name>/package.json` and that package's `CHANGELOG.md`. The changelog
entry uses the heading `## [version] - YYYY-MM-DD`; run `vp run format:changelog`
after editing it.

Run `vp run validate` and merge the pull request only after validation passes.
From `main`, create and push a component tag whose name matches the package
and manifest version, such as `pi-web-search-v0.5.0`:

```bash
git tag <name>-v<version> && git push origin <name>-v<version>
```

The tag starts the release workflow. After it completes, verify the CI result,
GitHub release, npm version, provenance, and tarball contents.

The tag name and manifest version must match. Publishing is automatic: the `publish` environment currently has no manual approval, so verify the package and version before pushing the tag. `scripts/release.ts notes <package> <file>` extracts the released changelog section for the release notes.

## Changelogs

Each package owns its `CHANGELOG.md`. Use [Keep a Changelog 2.0.0](https://keepachangelog.com/en/2.0.0/): `# Changelog`, an `Unreleased` section, dated version headings, one comparison link per version, and the standard `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security` sections. Do not repeat the package name as a bullet scope.

## Recovery and bootstrap

If a tagged release fails, first check `npm view <package>@<version>`. Published versions are permanent: reconcile the existing GitHub release and provenance instead of republishing. If npm does not contain the version, delete the partial GitHub release and remote tag, correct the commit, and recreate the tag.

Trusted publishing cannot publish a package's first registry version ([npm limitation](https://github.com/npm/cli/issues/8544)). Before merging a new package, publish an inspected one-off `0.0.0` with `--tag bootstrap` (do not commit that version), configure the npm trusted publisher for `zeldrisho/pi-packages`, workflow `release.yml`, environment `publish`, then use the normal process. Stop if the package name, version, access, tarball, or publisher settings are unexpected.

Pause and notify the owner if any manifest, tag, package path, changelog, authentication, OIDC, provenance, or publication detail disagrees or fails.

## Invariants

Keep the manifest, component tag, GitHub release, npm version, and changelog synchronized. The agent writes changelogs; the workflow only reads them. Update work branches from their target with a merge commit; do not rebase.
