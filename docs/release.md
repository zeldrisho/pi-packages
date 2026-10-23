# Release

Packages are versioned independently. The agent updates the manifest and changelog, then pushes a component tag. The tag triggers [the release workflow](../.github/workflows/release.yml), which creates a GitHub release from the changelog and publishes to npm with trusted publishing (OIDC).

## Normal release

A release starts by confirming the package and version, then updating
`packages/<name>/package.json` and that package's `CHANGELOG.md`. The changelog
entry uses the heading `## [version] - YYYY-MM-DD`; run `vp run format:changelog`
after editing it.

Run `vp run ready` and merge the pull request only after all checks pass.
From `main`, create and push a component tag whose name matches the package
and manifest version, such as `pi-web-search-v0.5.0`:

```bash
git tag <name>-v<version> && git push origin <name>-v<version>
```

Push tags one at a time. GitHub does not create tag-push events when more than
three tags are pushed in a single push, so batched pushes will not start the
release workflows.

The tag starts the release workflow. After it completes, verify the CI result,
GitHub release, npm version, provenance, and tarball contents. The workflow is
safe to retry after partial completion: it verifies an existing GitHub release
matches the tag, commit, and expected title, then checks the exact package version
on npm before publishing. Registry lookup errors other than a confirmed `404`
stop the workflow; an existing version must have matching package/version metadata
and registry integrity metadata. Published versions are immutable, so investigate
any mismatch rather than attempting to overwrite or republish them.

The tag name and manifest version must match. Publishing is automatic: the `publish` environment currently has no manual approval, so verify the package and version before pushing the tag. `scripts/release.ts notes <package> <file>` extracts the released changelog section for the release notes.

## Changelogs

Each package owns its `CHANGELOG.md`. Use [Keep a Changelog 2.0.0](https://keepachangelog.com/en/2.0.0/): `# Changelog`, an `Unreleased` section, dated version headings, one comparison link per version, and the standard `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security` sections. Do not repeat the package name as a bullet scope.

## Recovery and bootstrap

If a tagged release fails, first check `npm view <package>@<version>`. Published versions are permanent: reconcile the existing GitHub release and provenance instead of republishing. If npm does not contain the version, delete the partial GitHub release and remote tag, correct the commit, and recreate the tag.

Trusted publishing cannot publish a package's first registry version ([npm limitation](https://github.com/npm/cli/issues/8544)). Before pushing a new package's first release tag, publish an inspected one-off `0.0.0`, conventionally with `--tag bootstrap`, then configure the npm trusted publisher for `zeldrisho/pi-packages`, workflow `release.yml`, environment `publish`. The published version is what makes trust configuration possible; the `bootstrap` tag only labels the placeholder. Do not commit the `0.0.0` version. Do not push the first release tag before the bootstrap and trust configuration succeed: the workflow creates the GitHub release before publishing, so a failed first publish leaves a partial release.

Run the bootstrap from inside the package directory. `vp pm` is the fallback for package-manager commands that Vite+ does not provide; it delegates to the repository's pinned pnpm. Use `vp pm` for the package operations and `npm` only for trusted-publisher configuration, which has no `vp pm` equivalent:

```bash
vp pm pkg set version=0.0.0
vp pm pack -- --dry-run
vp pm login
vp pm publish --access public --tag bootstrap --no-git-checks
git restore package.json
npm trust github <package> \
  --file release.yml \
  --repo zeldrisho/pi-packages \
  --env publish \
  --allow-publish -y
npm trust list <package>
```

`vp` is not an npm wrapper: `vp pkg`, `vp pm trust`, and `vp pm pack --dry-run` without `--` do not work, and `vp pack` is the Vite+ build command, not an npm tarball pack. Pass `--` when forwarding pack options through `vp pm`.

`vp pm login` opens a browser; if it cannot, set `BROWSER`. An unauthenticated publish of a new package returns `404`, so log in before treating that response as fatal. Because `vp pm pkg set` leaves the manifest dirty, pnpm refuses to publish unless `--no-git-checks` is passed. Do not pass `--no-git-checks` to npm, which warns that it is unknown and ignores it.

The trust command needs the package to exist, so run it after the bootstrap publish. It requires 2FA and reports the configured permissions, which may include stage publishing. Confirm the configuration with `npm trust list` before tagging.

npm can create a `<version>-stage` stub while deferring 2FA for the first publish. The stub has `"stub": true`, no dist-tag, and is an internal staged-publishing placeholder, not a release; it does not replace the manual bootstrap.

Confirm the publish output names the expected package at `0.0.0` and shows the `bootstrap` tag. If published with the default `latest` tag by mistake, add the `bootstrap` tag with `npm dist-tag add <package>@0.0.0 bootstrap`. Do not try to remove `latest` while it points to the only published version; the registry may reject that operation. The first normal release will move `latest` to its published version. Restore the intended release version in the manifest without committing `0.0.0`. Stop if the package name, version, access, tarball, or publisher settings are unexpected or publishing fails. Normal releases continue to publish through the automated trusted-publishing workflow.

Pause and notify the owner if any manifest, tag, package path, changelog, authentication, OIDC, provenance, or publication detail disagrees or fails.

## Invariants

Keep the manifest, component tag, GitHub release, npm version, and changelog synchronized. The agent writes changelogs; the workflow only reads them.
