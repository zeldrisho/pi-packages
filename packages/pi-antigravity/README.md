# @zeldrisho/pi-antigravity

Use Google Antigravity models from Pi with your Google AI Pro or Ultra subscription. The extension signs in with your Google account; no Gemini API key is required.

## Requirements

- An active Google AI Pro or Ultra plan with Antigravity access.
- A web browser on the machine running Pi to finish sign-in.

The `agy` CLI is optional. The extension is unofficial; Google may change or restrict access.

## Install

```bash
pi install npm:@zeldrisho/pi-antigravity

# Project:
pi install -l npm:@zeldrisho/pi-antigravity
```

Restart Pi after installing. Use `pi config` to enable or disable the extension, and `pi list` to see installed packages.

## Configure sign-in

Run `/login` and choose **Antigravity (Google account)**; no other setup is required.

The extension bundles the public installed-application OAuth client that the official CLI ships, so sign-in and token refresh work without installing `agy`. It never reads the CLI's account login or token store. If you have `agy` installed and Google rotates to a client pair already recognized by the extension, it prefers that matching pair from the installed binary; an unknown rotation requires an extension update. Otherwise the bundled client is used.

This unofficial integration identifies requests as the Antigravity client, advertises a bundled CLI version, and rephrases a few phrases in Pi's default system prompt for provider compatibility. Google may restrict this use or your account; check its terms and decide whether to accept that risk. Review the Google consent screen and grant access only if you trust the extension.

## Sign in

1. Run `/login`.
2. Choose **Antigravity (Google account)** and press Enter.
3. Open the printed URL, approve access, and paste the callback URL back into Pi if the browser does not return to it automatically.

Pi stores the resulting tokens in its credential store and refreshes them before they expire. Run `/logout` and choose the provider to remove them. If you previously signed in using a different OAuth client, log out and sign in again.

## Usage

1. Run `/model`.
2. Type `antigravity` to filter the list.
3. Select a model tagged `[antigravity]`.

The model list is account-specific and is refreshed from Antigravity; the extension intentionally keeps no stale static model list. Pi maps the advertised thinking levels onto Antigravity runtime models and reasoning settings. For matching Gemini models, the extension also fetches Pi's Google and Vertex catalogs to constrain thinking levels and limits; Antigravity still determines availability and runtime routes. Catalog metadata is cached for four hours and refreshed when Pi refreshes models.

### Optional custom token budgets

For a single runtime that advertises a token budget, the extension automatically uses Pi's configured budgets. For example, add `thinkingBudgets` to Pi's `settings.json`:

```json
{
  "thinkingBudgets": { "minimal": 1024, "low": 2048, "medium": 8192, "high": 16384 }
}
```

For a level without a configured budget, the advertised budget is used. Overrides require live catalog metadata confirming a token budget; requests fail safely if that metadata is unavailable or the runtime uses named levels instead. The requested budget is capped to leave 1,024 output tokens for the answer. These are requests, not guarantees: Antigravity may reject, limit, or ignore a budget, and different budgets can affect quota usage. Pi's `thinkingBudgets` setting also affects other token-budget providers.

If account discovery fails, the extension keeps the last catalog it saw. On a first run or offline start, no static models are advertised until account discovery succeeds.

## Subscription limits

Antigravity enforces account plan and rate limits across its Gemini models. When a limit is reached, the extension reports the provider's message; switch models or wait for the reset shown in the error.

Antigravity may also change which models your plan can use. If a model is rejected with a permission error, select another model.

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-antigravity

# Project:
pi remove -l npm:@zeldrisho/pi-antigravity
```

## License

[MIT](LICENSE)
