# @zeldrisho/pi-catppuccin

Catppuccin Mocha theme for Pi, updated for the current Pi theme format. Choose this fixed palette when you want Pi to use Catppuccin Mocha regardless of your terminal colors; choose Pi's built-in `system` theme to adapt to your terminal palette instead.

## Install

```bash
pi install npm:@zeldrisho/pi-catppuccin

# Project:
pi install -l npm:@zeldrisho/pi-catppuccin
```

## Configure

If the theme is disabled, enable it under this package in `pi config`. Then select `catppuccin-mocha` from `/settings`, or set it in `settings.json`:

```json
{
  "theme": "catppuccin-mocha"
}
```

## Attribution

The theme uses colors from the official [Catppuccin Mocha palette](https://catppuccin.com/palette/#mocha), following Catppuccin’s [style guide](https://github.com/catppuccin/catppuccin/blob/main/docs/style-guide.md) where Pi’s token model allows. The selected-row background uses `surface0` as a palette-only approximation of the guide’s translucent `overlay2` selection recommendation; Pi themes do not support alpha colors. For the closest appearance, use this theme with a Catppuccin Mocha terminal background.

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-catppuccin

# Project:
pi remove -l npm:@zeldrisho/pi-catppuccin
```

## License

[MIT](../../LICENSE).
