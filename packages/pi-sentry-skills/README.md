# @zeldrisho/pi-sentry-skills

Pi adaptations of [`getsentry/skills`](https://github.com/getsentry/skills/tree/c2f99a5b04b4cd992ec3022d7c2c3e23e938d241): `agents-md`, `security-review`, and `pr-writer`. The skills and security references have been revised for Pi and Agent Skills workflows; they are not verbatim upstream copies and are not endorsed by Sentry.

## Install

```bash
pi install npm:@zeldrisho/pi-sentry-skills
# project-local:
pi install -l npm:@zeldrisho/pi-sentry-skills
```

Select individual skills with [Pi package filtering](../../docs/package-filtering.md). Upstream paths, pinned revision, change status, and license scope are documented in [`licenses/README.md`](licenses/README.md).

## License

This package contains adapted Sentry material under Apache-2.0 and OWASP-derived security reference material under CC BY-SA 4.0, alongside package-authored changes. See [`licenses/README.md`](licenses/README.md) for file scope and applicable terms.
