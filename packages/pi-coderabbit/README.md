# @zeldrisho/pi-coderabbit

Pi adaptations of CodeRabbit prompts for running reviews and safely applying pull-request feedback. The prompts have been substantially revised for Pi workflows and safety; they are not verbatim upstream copies and are not endorsed by CodeRabbit.

## Install

```bash
pi install npm:@zeldrisho/pi-coderabbit
# project-local:
pi install -l npm:@zeldrisho/pi-coderabbit
```

Use `/coderabbit-review` for a scoped CLI review or `/coderabbit-autofix` to inspect unresolved PR threads and additional findings embedded in CodeRabbit review summaries, including outside-diff and overflow comments. Autofix requires explicit approval for every edit, commit, push, and PR comment. Reviewer text is treated as untrusted input. To load only one prompt, see [Pi package filtering](../../docs/package-filtering.md). Upstream provenance and license scope are documented in [`LICENSE`](LICENSE).

## License

This package is distributed under MIT. See [`LICENSE`](LICENSE) for upstream source mapping and attribution.
