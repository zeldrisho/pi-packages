# @zeldrisho/pi-antigravity

Use Google Antigravity models from Pi with your Google AI Pro or Ultra subscription. The extension signs in with your Google account; it requires a separately configured Google OAuth client, but no Gemini API key or Antigravity installation.

## Requirements

- An active Google AI Pro or Ultra plan with Antigravity access.
- A web browser on the machine running Pi to finish sign-in.
- A Google OAuth desktop client ID and client secret. **Access using a user-created client has not been verified:** Google may restrict the required scopes or reject access to Antigravity for that client.

## Install

```bash
pi install npm:@zeldrisho/pi-antigravity

# Project:
pi install -l npm:@zeldrisho/pi-antigravity
```

Restart Pi after installing. Use `pi config` to enable or disable the extension, and `pi list` to see installed packages.

## Configure your OAuth client

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project and configure its OAuth consent screen. If the app is in testing mode, add your Google account as a test user.
2. Create an OAuth client with application type **Desktop app**. See Google's [installed-app OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app#creatingcred).
3. In the shell where you will start Pi, set the client ID and secret. Avoid putting the secret in shell history or committing it to a repository:

   ```bash
   read -r -p 'OAuth client ID: ' PI_ANTIGRAVITY_CLIENT_ID
   read -r -s -p 'OAuth client secret: ' PI_ANTIGRAVITY_CLIENT_SECRET; echo
   export PI_ANTIGRAVITY_CLIENT_ID PI_ANTIGRAVITY_CLIENT_SECRET
   pi
   ```

Keep these variables available whenever Pi refreshes your login. Google may require additional scope approval or disallow the private Antigravity scopes for your client; creating a client alone does not guarantee access.

## Sign in

1. Run `/login`.
2. Choose **Antigravity (Google account)** and press Enter.
3. Open the printed URL, approve access, and paste the callback URL back into Pi if the browser does not return to it automatically.

Pi stores the resulting tokens in its credential store and refreshes them before they expire. Run `/logout` and choose the provider to remove them. If you previously signed in using different client credentials, log out and sign in again with your own client.

The sign-in asks Google for Antigravity and Cloud Platform access so the extension can read your Antigravity project and send model requests on your behalf. Credentials never leave your machine except in requests to Google.

## Usage

1. Run `/model`.
2. Type `antigravity` to filter the list.
3. Select a model tagged `[antigravity]`.

The model list is read from your account when Pi refreshes models. Availability can change, and a listed model may still be rejected. A recently observed catalog:

| Model                    | Thinking levels   | Input       |
| ------------------------ | ----------------- | ----------- |
| Gemini 3.8 Flash         | low, medium, high | Text, image |
| Claude Sonnet 4.6        | thinking          | Text, image |
| Claude Opus 4.6 Thinking | thinking          | Text, image |
| GPT-OSS 120B             | medium            | Text        |

Pi maps its thinking levels onto the available Antigravity runtime models and reasoning budgets. Fixed-effort Claude models appear as `high` in Pi because Pi requires a level label; this does not mean their effort is adjustable. GPT-OSS appears as `medium`. Existing cached models may retain older level choices until the next catalog refresh.

If discovery fails, the extension keeps the last catalog it saw, or a small built-in list on a first run.

## Subscription limits

Antigravity enforces separate quota pools for Gemini and for Claude/GPT models, with 5-hour and weekly limits. When a limit is reached, the extension reports the provider's message; switch model families or wait for the reset shown in the error.

Antigravity may also change which models your plan can use. If a model is rejected with a permission error, select another model.

## Uninstall

```bash
pi remove npm:@zeldrisho/pi-antigravity

# Project:
pi remove -l npm:@zeldrisho/pi-antigravity
```

## License

[MIT](LICENSE)
