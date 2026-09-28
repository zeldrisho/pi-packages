# anti-slop provenance

Source repository: `dmmulroy/anti-slop` (installed from the `install-anti-slop` skill bundle).
Source commit: unknown; the bundle does not provide a recoverable repository revision.

Installed entry points:

- `tools/oxlint/anti-slop/index.ts`
- `tools/oxlint/anti-slop/effect/index.ts` (opt-in and not enabled here)

The bundled generic rules and shared helpers were merged into the existing vendored
installation. New generic rules include `no-array-filter-map`,
`no-reduce-accumulator-copy`, and `require-readable-spacing`; the existing local
Effect rule was retained alongside the bundled Effect additions. The vendored
`vendor/eslint-stylistic` license and provenance are retained verbatim.

Intentional repository deviations:

- Effect rules remain disabled because this repository has no direct `effect`
  dependency.
- The anti-slop imports use Vite+'s `vite-plus/lint/plugins` export, avoiding a
  separate direct Oxlint plugin dependency.
- Existing Vite+ configuration, ignores, and the `no-runtime-typeof` option were
  preserved. All generic anti-slop rules, plus native `oxc/no-accumulating-spread`,
  are enabled at error severity.

Pre-update backup: `/tmp/anti-slop-backup.zVyFxp`.
