# Package filtering

Use package filters to load only selected extensions, skills, prompts, or themes from a package. Filters belong in the `packages` array in Pi settings: user settings are `~/.pi/agent/settings.json`; project settings are `.pi/settings.json`.

Replace the package's string entry with an object entry (do not keep both):

```json
{
  "packages": [
    {
      "source": "npm:@zeldrisho/pi-anthropics-skills",
      "skills": ["skills/documentation"]
    }
  ]
}
```

This loads only the `documentation` skill. To select another skill, use its package-relative directory path:

- `@zeldrisho/pi-anthropics-skills`: `skills/testing-strategy`, `skills/tech-debt`
- `@zeldrisho/pi-sentry-skills`: `skills/security-review`, `skills/agents-md`, `skills/pr-writer`

The same filtering works for prompt templates. For example, load only CodeRabbit's review prompt:

```json
{
  "packages": [
    {
      "source": "npm:@zeldrisho/pi-coderabbit",
      "prompts": ["prompts/coderabbit-review.md"]
    }
  ]
}
```

Use `prompts: []` to load no prompts, or select `prompts/coderabbit-autofix.md` instead. Paths are relative to the package root.

## Filter behavior

- Omit a resource key (such as `skills`) to load all resources of that type.
- Set it to `[]` to load none of that type.
- Use glob patterns to select multiple paths; prefix a pattern with `!` to exclude matches.
- Prefix an exact path with `+` to force-include it, or `-` to force-exclude it.
- Filters only narrow what the package manifest allows; they cannot add resources outside it.

To manage resources interactively, run `pi config`; press Tab to switch between global and project settings. Use `pi config -l` to start in project-local settings.

For Pi's user-facing settings syntax, see [Select package resources](https://pi.dev/docs/latest/packages#select-package-resources). This section documents filtering packages in your settings; the rest of that page also covers package authoring.
