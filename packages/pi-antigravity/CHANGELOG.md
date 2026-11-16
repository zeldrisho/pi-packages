# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Sign in with a Google AI Pro or Ultra account through `/login` using a user-configured Google OAuth client, subject to Google's scope and client restrictions.
- Use the Gemini, Claude, and GPT-OSS models your plan can reach, with the catalog read from your account and Pi thinking levels mapped to Antigravity runtime models and reasoning budgets.
- Tool calling, image input, streamed reasoning, and subscription usage reporting.
- Automatic token refresh and endpoint failover when a region is at capacity.
- Advertise the Antigravity CLI version from its installed binary when available, falling back to a verified default.
- Use account-advertised thinking levels and budgets when available, and limit Pi's selectable effort levels to advertised variants.
- Rephrase two phrases in Pi's default system prompt to avoid observed provider-side 429 errors.
- Preserve streamed thinking signatures and omit unsigned thinking from conversation history, allowing Claude follow-up messages to continue.
