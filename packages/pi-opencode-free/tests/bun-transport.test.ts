import { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import {
  BUN_PATH_ENV,
  BunTransportError,
  createBunTransport,
  type ProxySpawn,
} from "../src/bun-transport";

const GATEWAY_URL = "https://opencode.ai/inference/v1/chat/completions";

const MODELS_URL = "https://opencode.ai/inference/v1/models";

interface FetchCall {
  input: Parameters<typeof fetch>[0];
  init: Parameters<typeof fetch>[1];
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv | undefined;
}

/** Stand-in for the Bun process; tests drive startup by hand. */
class FakeProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly signals: Array<string | undefined> = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);

    return true;
  }

  announce(port: number): void {
    this.stdout.emit("data", Buffer.from(`READY ${port}\n`));
  }

  fail(message: string, code = 1): void {
    this.stderr.emit("data", Buffer.from(message));
    this.emit("exit", code, null);
  }
}

/** Builds a spawn double that replays one fake process per call. */
function spawnHarness(children: readonly FakeProcess[]) {
  const calls: SpawnCall[] = [];
  let index = 0;

  const spawnProcess: ProxySpawn = (command, args, options) => {
    calls.push({ command, args: [...args], env: options.env });

    const child = children[index];

    index += 1;

    if (!child) throw new Error("unexpected spawn call");

    return child;
  };

  return { calls, spawnProcess };
}

/** Records fetches and answers them with the supplied body. */
function fetchHarness(body = "ok", status = 200) {
  const calls: FetchCall[] = [];

  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ input, init });

    return new Response(body, { status });
  };

  return { calls, fetcher };
}

/** Reads a request body regardless of the concrete `BodyInit` shape. */
async function readBody(body: BodyInit | null | undefined): Promise<string> {
  return body === undefined || body === null ? "" : new Response(body).text();
}

async function captureError(promise: Promise<Response>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }

  return new Error("expected the transport to reject");
}

describe("Bun gateway transport", () => {
  it.each([
    "https://pi.dev/api/models/providers/opencode?types=chat",
    "https://opencode.ai/models",
    "https://opencode.ai/docs",
    "https://example.test/inference/v1/chat/completions",
    "http://opencode.ai/inference/v1/chat/completions",
  ])("passes %s through without starting Bun", async (url) => {
    const harness = spawnHarness([]);
    const fetches = fetchHarness();

    const transport = createBunTransport({
      spawnProcess: harness.spawnProcess,
      fetch: fetches.fetcher,
    });

    const init: RequestInit = { method: "GET", headers: { "x-test": "kept" } };

    const response = await transport(url, init);

    expect(response.status).toBe(200);
    expect(harness.calls).toHaveLength(0);
    expect(fetches.calls).toHaveLength(1);
    expect(fetches.calls[0]?.input).toBe(url);
    expect(fetches.calls[0]?.init).toBe(init);
  });

  it("forwards gateway requests through a loopback proxy with sanitized headers", async () => {
    const child = new FakeProcess();
    const harness = spawnHarness([child]);
    const fetches = fetchHarness("data: [DONE]\n\n");

    const transport = createBunTransport({
      bunPath: "/opt/bun/bin/bun",
      spawnProcess: harness.spawnProcess,
      fetch: fetches.fetcher,
    });

    const payload = JSON.stringify({ model: "deepseek-v4.1-flash-free", stream: true });

    const pending = transport(`${GATEWAY_URL}?trace=1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-session": "ses_abc",
        host: "opencode.ai",
        connection: "keep-alive",
        "content-length": String(payload.length),
        "x-pi-proxy-token": "spoofed",
      },
      body: payload,
    });

    child.announce(4321);

    const response = await pending;

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: [DONE]\n\n");
    expect(harness.calls).toHaveLength(1);

    const [spawned] = harness.calls;
    const script = spawned?.args[0];

    expect(spawned?.command).toBe("/opt/bun/bin/bun");
    expect(script).toMatch(/pi-opencode-free-.+\/proxy\.mjs$/u);
    expect(script && existsSync(script)).toBe(true);
    expect(script && statSync(script).mode & 0o077).toBe(0);

    const token = spawned?.env?.PI_PROXY_TOKEN;

    expect(token).toMatch(/^[0-9a-f]{32}$/u);
    expect(fetches.calls).toHaveLength(1);

    const [forwarded] = fetches.calls;

    expect(forwarded?.input).toBe("http://127.0.0.1:4321/inference/v1/chat/completions?trace=1");
    expect(forwarded?.init?.method).toBe("POST");
    expect(forwarded?.init?.redirect).toBe("manual");
    expect(await readBody(forwarded?.init?.body)).toBe(payload);

    const headers = new Headers(forwarded?.init?.headers);

    expect(headers.get("x-pi-proxy-token")).toBe(token);
    expect(headers.get("x-opencode-session")).toBe("ses_abc");
    expect(headers.get("content-type")).toBe("application/json");

    for (const name of [
      "host",
      "connection",
      "content-length",
      "keep-alive",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]) {
      expect(headers.has(name)).toBe(false);
    }
  });

  it("reuses the running proxy and sends no body for GET", async () => {
    const child = new FakeProcess();
    const harness = spawnHarness([child]);
    const fetches = fetchHarness('{"object":"list"}');

    const transport = createBunTransport({
      spawnProcess: harness.spawnProcess,
      fetch: fetches.fetcher,
    });

    const posting = transport(GATEWAY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    child.announce(5000);
    await posting;

    const response = await transport(MODELS_URL, {
      method: "GET",
      headers: { authorization: "Bearer public" },
    });

    expect(response.status).toBe(200);
    expect(harness.calls).toHaveLength(1);
    expect(fetches.calls).toHaveLength(2);
    expect(fetches.calls[1]?.input).toBe("http://127.0.0.1:5000/inference/v1/models");
    expect(fetches.calls[1]?.init?.body).toBeUndefined();
  });

  it("prefers the Bun environment override", async () => {
    const child = new FakeProcess();
    const harness = spawnHarness([child]);
    const fetches = fetchHarness();
    const previous = process.env[BUN_PATH_ENV];

    process.env[BUN_PATH_ENV] = "/custom/bun";

    try {
      const transport = createBunTransport({
        spawnProcess: harness.spawnProcess,
        fetch: fetches.fetcher,
      });

      const pending = transport(GATEWAY_URL, { method: "GET" });

      child.announce(6000);
      await pending;

      expect(harness.calls[0]?.command).toBe("/custom/bun");
    } finally {
      if (previous === undefined) delete process.env[BUN_PATH_ENV];
      else process.env[BUN_PATH_ENV] = previous;
    }
  });

  it("reports install guidance when Bun cannot start", async () => {
    const child = new FakeProcess();
    const harness = spawnHarness([child]);
    const fetches = fetchHarness();

    const transport = createBunTransport({
      spawnProcess: harness.spawnProcess,
      fetch: fetches.fetcher,
    });

    const pending = transport(GATEWAY_URL, { method: "GET" });

    child.fail("bun: command not found", 127);

    const error = await captureError(pending);

    expect(error).toBeInstanceOf(BunTransportError);
    expect(error.message).toContain("bun: command not found");
    expect(error.message).toContain(`Install Bun or set ${BUN_PATH_ENV}.`);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(fetches.calls).toHaveLength(0);
  });

  it("starts a new proxy after a failed attempt", async () => {
    const first = new FakeProcess();
    const second = new FakeProcess();
    const harness = spawnHarness([first, second]);
    const fetches = fetchHarness();

    const transport = createBunTransport({
      spawnProcess: harness.spawnProcess,
      fetch: fetches.fetcher,
    });

    const failing = transport(GATEWAY_URL, { method: "GET" });

    first.fail("bind failed");
    expect((await captureError(failing)).message).toContain("bind failed");

    const retrying = transport(MODELS_URL, { method: "GET" });

    second.announce(7000);
    await retrying;

    expect(harness.calls).toHaveLength(2);
    expect(fetches.calls.at(-1)?.input).toBe("http://127.0.0.1:7000/inference/v1/models");
  });
});
