# @zeldrisho/pi-coderabbit

Pi prompt templates for running CodeRabbit reviews and safely applying CodeRabbit pull-request feedback.

## Install

```bash
pi install npm:@zeldrisho/pi-coderabbit
# project-local:
pi install -l npm:@zeldrisho/pi-coderabbit
```

Use `/coderabbit-review` for a scoped CLI review or `/coderabbit-autofix` to inspect unresolved PR threads. Autofix requires explicit approval for every edit, commit, push, and PR comment. Reviewer text is treated as untrusted input.

## License

[MIT](../../LICENSE). The prompt content is adapted from [CodeRabbit AI's skills](https://github.com/coderabbitai/skills), also MIT licensed.
