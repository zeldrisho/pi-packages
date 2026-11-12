import { parseHTML } from "linkedom";

/** Parse the observed Reddit challenge without executing server-provided JavaScript. */
export function redditChallengeUrl(raw: string, pageUrl: URL): URL | undefined {
  if (
    pageUrl.protocol !== "https:" ||
    !["reddit.com", "www.reddit.com", "old.reddit.com"].includes(pageUrl.hostname) ||
    pageUrl.username ||
    pageUrl.password ||
    pageUrl.port
  )
    return undefined;
  const { document } = parseHTML(raw);
  const forms = document.querySelectorAll("form");

  if (forms.length !== 1) return undefined;
  const form = forms[0];

  if (!form.hasAttribute("hidden") || form.getAttribute("method")?.toLowerCase() !== "get")
    return undefined;
  const action = form.getAttribute("action");

  if (!action) return undefined;
  let target: URL;

  try {
    target = new URL(action, pageUrl);
  } catch {
    return undefined;
  }

  if (
    target.origin !== pageUrl.origin ||
    target.pathname !== pageUrl.pathname ||
    target.search ||
    target.hash
  )
    return undefined;
  const inputs = [...form.querySelectorAll("input")];

  if (inputs.length !== 4) return undefined;
  const values = new Map<string, string>();

  for (const input of inputs) {
    const name = input.getAttribute("name");

    if (!name || values.has(name) || input.getAttribute("type")?.toLowerCase() !== "hidden")
      return undefined;
    values.set(name, input.getAttribute("value") ?? "");
  }

  const token = values.get("jsc_token");

  if (
    values.get("solution") !== "" ||
    values.get("js_challenge") !== "1" ||
    !token ||
    !/^[a-f0-9]{1,256}$/i.test(token) ||
    values.get("jsc_orig_r") !== ""
  )
    return undefined;

  for (const name of values.keys()) if (pageUrl.searchParams.has(name)) return undefined;

  if (pageUrl.search.length > 2048) return undefined;
  const scripts = [...document.querySelectorAll("script")];

  if (scripts.length !== 1 || scripts[0].hasAttribute("src")) return undefined;
  const script = scripts[0].textContent ?? "";

  if (script.length > 16_384) return undefined;

  // Match only the observed literal string-doubling expression. Never evaluate code.
  const match =
    /await\s*\(\s*async\s+([a-zA-Z_$][\w$]*)\s*=>\s*\1\s*\+\s*\1\s*\)\s*\(\s*(["'])([a-f0-9]{1,128})\2\s*\)/i.exec(
      script,
    );

  if (
    !match ||
    !/namedItem\(["']solution["']\)\.value\s*=/.test(script) ||
    !/requestSubmit\(\)/.test(script)
  )
    return undefined;
  target.searchParams.set("solution", match[3] + match[3]);
  target.searchParams.set("js_challenge", "1");
  target.searchParams.set("jsc_token", token);
  target.searchParams.set("jsc_orig_r", "");

  for (const [key, value] of pageUrl.searchParams) target.searchParams.append(key, value);

  return target;
}
