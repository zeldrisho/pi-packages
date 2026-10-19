import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  executeWebFetch,
  fetchRemoteContent,
  requestPinned,
  type FetchRemoteDependencies,
  type ValidatedTarget,
} from "../../src/index";

const fixture = readFileSync(new URL("../fixtures/anubis-sha256.wasm", import.meta.url));

const AUTH_PAGE =
  "<html><head><title>Protected</title></head><body><main><h1>Protected content</h1><p>Real page body text.</p></main></body></html>";

const DIFFICULTY = new Map<string, number>([
  ["fast", 2],
  ["slow", 2],
  ["sha256", 8],
  ["hashx", 6],
  ["argon2id", 4],
  ["preact", 0],
  ["metarefresh", 0],
]);

interface PendingChallenge {
  method: string;
  randomData: string;
  difficulty: number;
}

interface PassRecord {
  id: string;
  params: Record<string, string>;
  testCookie: boolean;
}

let server: ReturnType<typeof createServer>;

let origin = "";

let dependencies: FetchRemoteDependencies;

let challengeRequests = 0;

let passRequests = 0;

let authRequests = 0;

let wasmRequests = 0;

let cssRequests = 0;

let rejectPass = false;

let skipTestCookie = false;

let missingWasm = false;

let difficultyOverride: number | undefined;

let publicUrl = "";

let extensions: string[] = [];

let pending = new Map<string, PendingChallenge>();

let passes: PassRecord[] = [];

function headersOf(request: IncomingMessage): string[] {
  const value = request.headers.cookie;

  if (value === undefined) return [];

  return Array.isArray(value) ? value : [value];
}

function hasAuthCookie(request: IncomingMessage): boolean {
  return headersOf(request).some((header) => header.includes("techaro.lol-anubis-auth=token"));
}

function hasVerificationCookie(request: IncomingMessage): boolean {
  return headersOf(request).some((header) =>
    header.includes("techaro.lol-anubis-cookie-verification"),
  );
}

function challengePage(challenge: PendingChallenge, id: string, extra: string): string {
  const payload = {
    rules: { algorithm: challenge.method, difficulty: challenge.difficulty },
    challenge: {
      id,
      method: challenge.method,
      randomData: challenge.randomData,
      difficulty: challenge.difficulty,
      extensions,
    },
  };

  return [
    "<html><head><title>Making sure you're not a bot!</title>",
    '<script id="anubis_version" type="application/json">"v1.28.1"</script>',
    '<script id="anubis_base_prefix" type="application/json">""</script>',
    `<script id="anubis_public_url" type="application/json">${JSON.stringify(publicUrl)}</script>`,
    `<script id="anubis_challenge" type="application/json">${JSON.stringify(payload)}</script>`,
    extra,
    "</head><body><p>Anubis is protecting this site with a proof of work.</p></body></html>",
  ].join("");
}

function sendChallenge(method: string, response: ServerResponse): string {
  const id = randomUUID();
  const difficulty = difficultyOverride ?? DIFFICULTY.get(method) ?? 2;

  const challenge: PendingChallenge = {
    method,
    randomData: createHash("sha256").update(id).digest("hex"),
    difficulty,
  };

  pending.set(id, challenge);

  if (!skipTestCookie) {
    response.setHeader("set-cookie", [
      `techaro.lol-anubis-cookie-verification=${randomUUID()}; Path=/`,
      `techaro.lol-anubis-cookie-verification-347ddb4a=${randomUUID()}; Path=/`,
    ]);
  }

  const css = extensions.includes("css-load")
    ? '<style>@import url("/protected/asset.css");</style><link rel="stylesheet" href="/protected/asset2.css">'
    : "";

  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(challengePage(challenge, id, css));

  return id;
}

/** Decodes a lowercase hex digest into bytes, or undefined when malformed. */
function decodeHex(value: string): Buffer | undefined {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/.test(value)) return undefined;

  return Buffer.from(value, "hex");
}

/** Narrows a WebAssembly export to a numeric function. */
function isWasmFunction(
  value: WebAssembly.ExportValue | undefined,
): value is (...args: number[]) => number {
  return typeof value === "function";
}

function exportFunction(exports: WebAssembly.Exports, name: string): (...args: number[]) => number {
  const value = exports[name];

  if (!isWasmFunction(value)) throw new Error(`fixture is missing ${name}`);

  return value;
}

/** Replays the fixture module's own validation for a sha256-style proof of work. */
function verifyWasm(
  randomData: string,
  hashHex: string,
  nonce: number,
  difficulty: number,
): boolean {
  const hash = decodeHex(hashHex);
  const data = decodeHex(randomData);

  if (!hash || !data || hash.length !== 32) return false;

  const instance = new WebAssembly.Instance(new WebAssembly.Module(fixture), {
    anubis: { anubis_update_nonce: () => {} },
  });

  const exports = instance.exports;
  const memory = exports.memory;

  if (!(memory instanceof WebAssembly.Memory)) return false;

  const dataPtr = exportFunction(exports, "data_ptr");
  const setDataLength = exportFunction(exports, "set_data_length");
  const verificationHashPtr = exportFunction(exports, "verification_hash_ptr");
  const validate = exportFunction(exports, "anubis_validate");

  new Uint8Array(memory.buffer, dataPtr(), data.length).set(data);
  setDataLength(data.length);
  new Uint8Array(memory.buffer, verificationHashPtr(), hash.length).set(hash);

  return validate(nonce, difficulty) === 1;
}

function verifyFast(challenge: PendingChallenge, params: URLSearchParams): boolean {
  const nonce = Number.parseInt(params.get("nonce") ?? "", 10);
  const digest = params.get("response") ?? "";

  const expected = createHash("sha256")
    .update(challenge.randomData)
    .update(String(nonce))
    .digest("hex");

  return digest === expected && digest.startsWith("0".repeat(challenge.difficulty));
}

function verifyPass(challenge: PendingChallenge, params: URLSearchParams): boolean {
  const nonce = Number.parseInt(params.get("nonce") ?? "", 10);

  switch (challenge.method) {
    case "fast":
    case "slow":
      return verifyFast(challenge, params);
    case "sha256":
    case "hashx":
    case "argon2id":
      return verifyWasm(
        challenge.randomData,
        params.get("response") ?? "",
        nonce,
        challenge.difficulty,
      );
    case "preact":
      return (
        (params.get("result") ?? "") ===
        createHash("sha256").update(challenge.randomData).digest("hex")
      );
    case "metarefresh":
      return params.get("challenge") === challenge.randomData;
    default:
      return false;
  }
}

function handlePass(url: URL, request: IncomingMessage, response: ServerResponse): void {
  passRequests += 1;

  const id = url.searchParams.get("id") ?? "";
  const challenge = pending.get(id);

  passes.push({
    id,
    params: Object.fromEntries(url.searchParams),
    testCookie: hasVerificationCookie(request),
  });

  const verified =
    challenge !== undefined && !rejectPass && hasVerificationCookie(request)
      ? verifyPass(challenge, url.searchParams)
      : false;

  if (!verified) {
    sendChallenge(challenge?.method ?? "fast", response);

    return;
  }

  response.setHeader("set-cookie", "techaro.lol-anubis-auth=token; Path=/");
  response.writeHead(302, { location: url.searchParams.get("redir") ?? "/" });
  response.end();
}

function handle(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", "http://internal");
  const path = url.pathname;

  if (path.startsWith("/.within.website/x/cmd/anubis/static/wasm/")) {
    wasmRequests += 1;

    if (missingWasm) {
      response.writeHead(404);
      response.end();

      return;
    }

    response.setHeader("content-type", "application/wasm");
    response.end(fixture);

    return;
  }

  if (path === "/.within.website/x/cmd/anubis/api/pass-challenge") {
    handlePass(url, request, response);

    return;
  }

  if (path === "/protected/asset.css" || path === "/protected/asset2.css") {
    cssRequests += 1;
    response.setHeader("content-type", "text/css");
    response.end(".x { color: red; }");

    return;
  }

  const match = /^\/protected\/([a-z0-9-]+)$/.exec(path);

  if (match) {
    if (hasAuthCookie(request)) {
      authRequests += 1;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(AUTH_PAGE);

      return;
    }

    challengeRequests += 1;
    sendChallenge(match[1], response);

    return;
  }

  response.writeHead(404);
  response.end();
}

beforeAll(async () => {
  server = createServer(handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // SAFETY: the server listens on a TCP port, so `server.address()` is an AddressInfo.
  const address = server.address() as AddressInfo;
  origin = `http://example.test:${address.port}`;
  dependencies = {
    validateUrl: async (value): Promise<ValidatedTarget> => ({
      url: value instanceof URL ? value : new URL(value),
      address: "127.0.0.1",
      family: 4,
      addresses: ["127.0.0.1"],
    }),
    request: (target, signal, headers) => requestPinned(target, signal, { headers }),
  };
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  challengeRequests = 0;
  passRequests = 0;
  authRequests = 0;
  wasmRequests = 0;
  cssRequests = 0;
  rejectPass = false;
  skipTestCookie = false;
  missingWasm = false;
  difficultyOverride = undefined;
  publicUrl = "";
  extensions = [];
  pending = new Map();
  passes = [];
});

let caseCounter = 0;

function protectedUrl(method: string): string {
  caseCounter += 1;

  return `${origin}/protected/${method}?case=${caseCounter}`;
}

describe("Anubis challenge solving", () => {
  it("solves a fast challenge end to end", async () => {
    const content = await fetchRemoteContent(
      protectedUrl("fast"),
      0,
      100_000,
      undefined,
      dependencies,
    );

    expect(content.markdown).toContain("Protected content");
    expect(passRequests).toBe(1);
    expect(passes[0]?.testCookie).toBe(true);
    expect(passes[0]?.params.response).toMatch(/^00/);
    expect(challengeRequests).toBe(1);
    expect(authRequests).toBe(1);
  });

  it("solves a slow challenge", async () => {
    const content = await fetchRemoteContent(
      protectedUrl("slow"),
      0,
      100_000,
      undefined,
      dependencies,
    );

    expect(content.markdown).toContain("Protected content");
  });

  it("runs the server-provided sha256 module", async () => {
    const content = await fetchRemoteContent(
      protectedUrl("sha256"),
      0,
      100_000,
      undefined,
      dependencies,
    );

    expect(content.markdown).toContain("Protected content");
    expect(wasmRequests).toBe(1);
    expect(passRequests).toBe(1);
  });

  it("runs the module for hashx and argon2id methods", async () => {
    for (const method of ["hashx", "argon2id"]) {
      challengeRequests = 0;

      const content = await fetchRemoteContent(
        protectedUrl(method),
        0,
        100_000,
        undefined,
        dependencies,
      );

      expect(content.markdown).toContain("Protected content");
      expect(wasmRequests).toBeGreaterThanOrEqual(1);
    }
  });

  it("solves a preact challenge", async () => {
    const content = await fetchRemoteContent(
      protectedUrl("preact"),
      0,
      100_000,
      undefined,
      dependencies,
    );

    expect(content.markdown).toContain("Protected content");
    expect(passes[0]?.params.result).toBeDefined();
    expect(passes[0]?.params.nonce).toBeUndefined();
  });

  it("solves a metarefresh challenge", async () => {
    const content = await fetchRemoteContent(
      protectedUrl("metarefresh"),
      0,
      100_000,
      undefined,
      dependencies,
    );

    expect(content.markdown).toContain("Protected content");
    expect(passes[0]?.params.challenge).toBeDefined();
  });

  it("performs css-load extension requests before the pass", async () => {
    extensions = ["css-load"];

    const content = await fetchRemoteContent(
      protectedUrl("fast"),
      0,
      100_000,
      undefined,
      dependencies,
    );

    expect(content.markdown).toContain("Protected content");
    expect(cssRequests).toBe(2);
  });

  it("does not reuse auth cookies across fetches", async () => {
    await fetchRemoteContent(protectedUrl("fast"), 0, 100_000, undefined, dependencies);
    await fetchRemoteContent(protectedUrl("fast"), 0, 100_000, undefined, dependencies);

    expect(challengeRequests).toBe(2);
    expect(authRequests).toBe(2);
  });
});

describe("Anubis challenge fallbacks", () => {
  it("reports the standard block for an unsupported method", async () => {
    const result = await executeWebFetch(
      { url: protectedUrl("soteria") },
      undefined,
      undefined,
      dependencies,
    );

    expect(result.content[0].text).toContain("Blocked by an anti-bot challenge.");
    expect(passRequests).toBe(0);
  });

  it("reports the standard block for an unsupported extension", async () => {
    extensions = ["mystery"];

    const result = await executeWebFetch(
      { url: protectedUrl("fast") },
      undefined,
      undefined,
      dependencies,
    );

    expect(result.content[0].text).toContain("Blocked by an anti-bot challenge.");
    expect(passRequests).toBe(0);
  });

  it("reports the standard block for a cross-origin public URL", async () => {
    publicUrl = "https://other.test/";

    const result = await executeWebFetch(
      { url: protectedUrl("fast") },
      undefined,
      undefined,
      dependencies,
    );

    expect(result.content[0].text).toContain("Blocked by an anti-bot challenge.");
    expect(passRequests).toBe(0);
  });

  it("reports the standard block when the server rejects the solution", async () => {
    rejectPass = true;

    const result = await executeWebFetch(
      { url: protectedUrl("fast") },
      undefined,
      undefined,
      dependencies,
    );

    expect(result.content[0].text).toContain("Blocked by an anti-bot challenge.");
    expect(passRequests).toBe(1);
  });

  it("reports the standard block when the verification cookie is missing", async () => {
    skipTestCookie = true;

    const result = await executeWebFetch(
      { url: protectedUrl("fast") },
      undefined,
      undefined,
      dependencies,
    );

    expect(result.content[0].text).toContain("Blocked by an anti-bot challenge.");
    expect(passes[0]?.testCookie).toBe(false);
  });

  it("reports the standard block when the wasm module is unavailable", async () => {
    missingWasm = true;

    const result = await executeWebFetch(
      { url: protectedUrl("sha256") },
      undefined,
      undefined,
      dependencies,
    );

    expect(result.content[0].text).toContain("Blocked by an anti-bot challenge.");
    expect(passRequests).toBe(0);
  });

  it("does not cache blocked challenge results", async () => {
    rejectPass = true;
    const url = protectedUrl("fast");

    const first = await executeWebFetch({ url }, undefined, undefined, dependencies);
    const second = await executeWebFetch({ url }, undefined, undefined, dependencies);

    expect(first.content[0].text).toContain("Blocked by an anti-bot challenge.");
    expect(second.content[0].text).toContain("Blocked by an anti-bot challenge.");
    expect(passRequests).toBe(2);
  });
});

describe("Anubis challenge cancellation", () => {
  it("cancels without waiting for a long proof of work", async () => {
    difficultyOverride = 40;
    const controller = new AbortController();
    const url = protectedUrl("fast");
    const fetchPromise = fetchRemoteContent(url, 0, 100_000, controller.signal, dependencies);

    setTimeout(() => controller.abort(), 40);

    await expect(fetchPromise).rejects.toThrow(/cancelled|aborted/i);
  });
});
