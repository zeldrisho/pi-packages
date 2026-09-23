# Third-party material and licensing

The package-level npm `license` field points here because this package contains material under more than one applicable license. Do not infer that every file is available only under MIT or that a single upstream license applies to all files.

## Sentry skill adaptations

`skills/agents-md/SKILL.md`, `skills/security-review/SKILL.md`, `skills/pr-writer/SKILL.md`, and the files under `skills/security-review/references/` are adapted from the corresponding `skills/` content in [getsentry/skills](https://github.com/getsentry/skills), pinned at commit [`c2f99a5b04b4cd992ec3022d7c2c3e23e938d241`](https://github.com/getsentry/skills/tree/c2f99a5b04b4cd992ec3022d7c2c3e23e938d241). The Pi skill instructions and reference files have been modified; paths and specific changes are recorded in [`SOURCES.txt`](SOURCES.txt). The Sentry-derived portions are under Apache License 2.0 (see [`getsentry-apache-2.0.txt`](getsentry-apache-2.0.txt)).

## OWASP-derived security references

The security-review skill's reference material is also derived from the [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/). The OWASP-derived portions and their adaptations are licensed CC BY-SA 4.0. Attribution, license link, and indication of changes are provided in [`security-review-owasp-cc-by-sa-4.0.txt`](security-review-owasp-cc-by-sa-4.0.txt); the Sentry security-review skill itself also identifies this source. Preserve these terms and attribution when redistributing or adapting those reference materials.

## Package-authored evaluation cases

The `skills/*/evals/evals.json` files were authored for this Pi package and are offered under MIT. Package-authored revisions are offered under MIT only to the extent they are separable and the upstream licenses permit; upstream obligations continue to apply to adapted material. This file is a provenance guide, not legal advice.
