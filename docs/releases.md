# Release guide

This guide describes the release process for maintainers and contributors.

Packages are versioned independently. On each push to `main`, git-cliff evaluates conventional commits that touched each package since its latest component tag. The release workflow updates one generated pull request with the required package versions and changelogs. Merging that pull request creates the component tags and GitHub releases, then publishes only missing package versions to npm.

The release job runs only when the push merges the generated release pull request, or when a release whose changelog entry already landed on `main` is still missing its tag, GitHub release, or npm version (a retry after a partial release). Regular feature merges never create tags, GitHub releases, or npm versions by themselves; they only update the generated release pull request. An untagged manifest version is the _pending initial release_ (for example a newly bootstrapped package): the workflow adds its changelog entry to the generated release pull request, and the release happens only when that pull request merges.

## Release invariants

- The git-cliff workflow manages existing package versions and changelogs. Keep package manifests, component tags, GitHub releases, npm versions, and changelogs synchronized.
- The generated release pull request is the only path to tags, GitHub releases, and npm publication. Do not merge feature branches that already carry a bumped `package.json` version; let `prepare` propose the version and changelog.
- Do not hand-edit the `git-cliff/release` branch or its generated artifacts to bypass checks. Fix the source change or release configuration instead.
- Only the repository owner merges pull requests. Publication, tags, GitHub releases, and protected-environment deployment require explicit approval for the specific package and expected version.
- Rebase work branches onto their target; never merge the target branch into them.
- Verify npm trusted publication end to end after every release.

## Configuration

Release behavior is defined by:

- [`cliff.toml`](../cliff.toml), configured using [git-cliff](https://git-cliff.org/docs/), which parses conventional commits, calculates semantic versions, and renders changelogs;
- [`scripts/release.ts`](../scripts/release.ts), which discovers packages, prepares release files, checks npm and GitHub state, and creates GitHub releases; and
- [`.github/workflows/release.yml`](../.github/workflows/release.yml), which validates, opens the generated release pull request, and publishes through npm trusted publishing.

The automation requires the repository `GITHUB_TOKEN`, a protected `publish` GitHub environment, and one npm trusted publisher per package for repository `zeldrisho/pi-packages`, workflow `release.yml`, environment `publish`, with the `npm publish` action allowed.

The workflow fetches complete tag history, serializes release runs, references reviewed semantic action versions so Dependabot can report security updates, and grants `id-token: write` only to the publishing job. The workflow validates the generated tree before updating `git-cliff/release`. GitHub places CI runs triggered by its `GITHUB_TOKEN` pull request in an approval-required state, so a maintainer must approve that exact-head run before merging.

## Version calculation

Only commits that touch `packages/<name>/**` affect that package. Breaking changes increment the major version, `feat` increments the minor version, and `fix`, `perf`, or `revert` increments the patch version. Documentation, refactoring, test, build, CI, and chore commits appear in release notes when bundled with a release but do not trigger a release by themselves.

Component tags use `<package-directory>-v<version>`, for example `pi-web-search-v0.5.0`.

## Bootstrap a new npm package

npm trusted publishing cannot publish a package's first registry version. This is a [known npm limitation](https://github.com/npm/cli/issues/8544). Bootstrap each new package before merging it to `main`:

1. Set the tracked `package.json` version to `0.1.0` and initialize its allowlisted `CHANGELOG.md` with `# Changelog`.
2. Complete repository checks and inspect the package tarball.
3. From an isolated copy of that inspected tarball, change only the temporary package version to `0.0.0` and publish it manually with `vp pm publish -- --access public --tag bootstrap`. Do not commit the bootstrap version.
4. Configure the package's npm trusted publisher for repository `zeldrisho/pi-packages`, workflow `release.yml`, environment `publish`, and the `npm publish` action.
5. Verify `0.0.0` and the `bootstrap` dist-tag on npm.

After the package change is merged, the workflow adds the untagged `0.1.0` entry to the generated release pull request as the initial release. Merging that pull request creates the `<package>-v0.1.0` component tag, its GitHub release, the npm `0.1.0` publication, and moves npm's `latest` tag to it.

Publishing the bootstrap version is irreversible. Stop if any name, version, access level, tarball content, or publisher setting is unexpected.

## Release procedure

1. Confirm the package and expected version with the repository owner.
2. Prepare one coherent change and pull request, then run the checks in [`development.md`](development.md).
3. The repository owner reviews and merges the change pull request.
4. Confirm that `git-cliff/release` proposes exactly the expected packages and versions. Do not edit the generated branch manually.
5. Approve the bot-triggered CI run and verify that the required `check` passes for the release pull request's exact head commit.
6. The repository owner reviews and merges the release pull request.
7. Approve the protected `publish` deployment only after confirming every package and version in its matrix.
8. Confirm CI, component tags, GitHub releases, OIDC publication, provenance, npm metadata, and tarball contents.

The workflow is retry-safe for partial releases: it checks component tags, GitHub releases, and npm versions independently and recreates only missing state. Stop and investigate rather than manually filling gaps.

## Escalation conditions

Pause the release and notify the repository owner if:

- npm, GitHub, package manifests, changelogs, tags, or workflow configuration disagree;
- any version, tag, package path, or release count is unexpected;
- the generated release pull request fails validation;
- updating a branch would require merging its target branch into it;
- authentication, OIDC, provenance, publication, or protected-environment deployment fails;
- an operation would bypass branch protection or rewrite a merged, tagged, released, or published commit; or
- publication, tagging, release creation, deployment approval, or a pull-request merge lacks explicit package-specific approval.
