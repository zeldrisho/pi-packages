# @zeldrisho/pi-coderabbit

Pi prompt templates for running CodeRabbit reviews and safely applying CodeRabbit pull-request feedback.

## Install

```bash
pi install npm:@zeldrisho/pi-coderabbit
# project-local:
pi install -l npm:@zeldrisho/pi-coderabbit
```

Use `/coderabbit-review` for a scoped CLI review or `/coderabbit-autofix` to inspect unresolved PR threads and additional findings embedded in CodeRabbit review summaries, including outside-diff and overflow comments. Autofix requires explicit approval for every edit, commit, push, and PR comment. Reviewer text is treated as untrusted input. To load only one prompt, see [Pi package filtering](../../docs/package-filtering.md).

## License

[MIT](../../LICENSE). The package metadata is MIT. Imported CodeRabbit material remains under its upstream MIT terms; see [`licenses/`](licenses).
