# @zeldrisho/pi-sentry-skills

Pi package of selected [Sentry agent skills](https://github.com/getsentry/skills), with supporting guides and Pi-compatible metadata. This package is not endorsed by Sentry.

| Skill             | Purpose                                                    |
| ----------------- | ---------------------------------------------------------- |
| `agents-md`       | Create and maintain repository agent instructions          |
| `security-review` | Review code for exploitable security vulnerabilities       |
| `pr-writer`       | Draft and update reviewer-facing pull request descriptions |

## Install

```bash
pi install npm:@zeldrisho/pi-sentry-skills
# project-local:
pi install -l npm:@zeldrisho/pi-sentry-skills
```

Select individual skills with [Pi package filtering](../../docs/package-filtering.md).

## License

Sentry-derived material is Apache-2.0; OWASP-derived security references are CC BY-SA 4.0. See the package [`LICENSE`](LICENSE) and the security-review skill's `LICENSE` for terms and attribution.
