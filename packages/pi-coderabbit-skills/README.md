# @zeldrisho/pi-coderabbit-skills

Pi package of [CodeRabbit skills](https://github.com/coderabbitai/skills), adapted only where needed for Pi skill compatibility. Not endorsed by CodeRabbit.

| Skill         | Purpose                                                                       |
| ------------- | ----------------------------------------------------------------------------- |
| `autofix`     | Review unresolved CodeRabbit PR threads and apply individually approved fixes |
| `code-review` | Run CodeRabbit CLI reviews and related workflows                              |

Both skills set `disable-model-invocation: true` and must be invoked explicitly:

```text
/skill:autofix
/skill:code-review
```

## Install

```bash
pi install npm:@zeldrisho/pi-coderabbit-skills

# Project:
pi install -l npm:@zeldrisho/pi-coderabbit-skills
```

## Requirements

The autofix skill requires `gh`, `git`, and `jq`. Code review requires the CodeRabbit CLI. Review each workflow and its security guidance before use. Use `pi config` to enable or disable individual skills interactively.

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-coderabbit-skills

# Project:
pi remove -l npm:@zeldrisho/pi-coderabbit-skills
```

## License

The upstream skills are MIT-licensed. See [`LICENSE`](LICENSE) for terms and attribution.
