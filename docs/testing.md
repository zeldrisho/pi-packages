# Manual Live Testing

Use this guide for opt-in end-to-end checks against real models, networks, and external services. Deterministic tests belong in each package's `tests/` directory; run them with `vp test <path>` or `vp run test:packages`. Architecture invariants are in [architecture.md](architecture.md), and the full pre-review checklist is in [development.md](development.md).

## Isolate the Pi process

Start from the repository root so relative extension paths resolve to the local packages under test. Always disable ambient discovery and load every extension explicitly:

```bash
cache_dir=$(mktemp -d)
trap 'rm -rf -- "$cache_dir"' EXIT

XDG_CACHE_HOME="$cache_dir" pi --no-session \
  --no-extensions --no-mcp --no-skills --no-prompt-templates \
  --no-themes --no-context-files --no-builtin-tools \
  -e ./packages/pi-opencode-free \
  -e ./packages/<package-under-test> \
  --model <model> \
  -p '<prompt>'
```

`--no-extensions` blocks globally installed copies, while each `-e` still loads the named local package. `--no-context-files` prevents repository `AGENTS.md` files and similar context from changing the test. `--no-builtin-tools` leaves only tools supplied by the explicitly loaded extensions. Use the temporary `XDG_CACHE_HOME` so stale persistent cache entries cannot mask a failure.

Always load `./packages/pi-opencode-free`; it supplies the provider used by the local test model. Add only the packages needed for the behavior under test. For a web fetch check:

```bash
-e ./packages/pi-opencode-free \
-e ./packages/pi-web-fetch
```

For web search, also add `-e ./packages/pi-web-search` and provide `BRAVE_SEARCH_API_KEY` in the environment. Never put credentials in the prompt, committed files, or captured output.

## Choose a model

Ask the user which model to use before running a live check. Do not assume a model name or silently fall back to a default. List the models exposed by the local provider setup:

```bash
pi --no-extensions -e ./packages/pi-opencode-free --list-models
```

Then pass the selected identifier with `--model <model>`. If the model is unavailable, report that limitation instead of treating the smoke test as completed.

## Exercise real behavior

Use a prompt that forces the extension's tool to run and asks for evidence from the result. A useful fetch check requests a known page and asks for its first heading or a distinctive sentence. A block check asks for the exact block message. For search, ask for cited results and a short summary.

For AWS WAF regression checks, candidate pages include Binance's [Pay REST API](https://developers.binance.com/docs/pay/rest-api), [deposit history](https://developers.binance.com/docs/wallet/capital/deposite-history), and [deposit FAQ](https://www.binance.com/en/support/faq/why-hasn-t-my-deposit-been-credited-115003736451). Ask for the page heading and any block, fallback, or truncation notice. These pages can change their protection at any time: receiving content alone does not prove that a challenge was presented or solved.

Do not accept a load-only invocation, a direct call to the implementation, or a mocked response as a manual live test. Confirm from the tool output that the intended path ran, the result is plausible, and failures are surfaced rather than silently replaced.

Record the command shape, selected model, target, observed result, and any limitation. Remove temporary directories and do not leave live-test fixtures or credentials in the worktree.

## Failure handling

Live tests may fail because of unavailable model credentials, network policy, third-party rate limits, or upstream changes. Distinguish those environmental failures from extension defects. If a check needs a system package, local solver, browser, or other external process, ask the user before installing or starting it.
