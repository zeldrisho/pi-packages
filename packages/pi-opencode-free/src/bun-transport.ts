import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Origin whose inference routes need the OpenCode client's TLS stack. */
const UPSTREAM_ORIGIN = "https://opencode.ai";

/** Only gateway routes are proxied; catalog and version lookups stay direct. */
const GATEWAY_PATH_PREFIX = "/inference/";

/** Loopback header carrying the per-process proxy token. */
const TOKEN_HEADER = "x-pi-proxy-token";

/** Upper bound for proxy startup before the request fails with guidance. */
const START_TIMEOUT_MS = 10_000;

/** Environment variable pointing at a Bun executable. */
export const BUN_PATH_ENV = "PI_OPENCODE_FREE_BUN";

/**
 * Proxy program executed by Bun.
 *
 * Bun's TLS stack matches the OpenCode CLI, which free-tier inference accepts
 * while generic Node, curl, and OpenSSL clients are refused. The proxy buffers
 * the request so the upstream connection carries a definite length and no
 * hop-by-hop headers, then streams the upstream body back unchanged. Identity
 * encoding avoids reporting a compressed body as an uncompressed one.
 */
const PROXY_SOURCE = `
const token = process.env.PI_PROXY_TOKEN;
const debugPath = process.env.PI_PROXY_DEBUG;
const upstreamOrigin = ${JSON.stringify(UPSTREAM_ORIGIN)};
const hopByHop = ["host", "connection", "content-length", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "${TOKEN_HEADER}"];

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    if (request.headers.get("${TOKEN_HEADER}") !== token) {
      return new Response("forbidden", { status: 403 });
    }

    const incoming = new URL(request.url);
    const headers = new Headers(request.headers);

    for (const name of hopByHop) headers.delete(name);
    headers.set("accept-encoding", "identity");

    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const requestBody = hasBody ? await request.arrayBuffer() : undefined;
    let upstream;

    try {
      upstream = await fetch(new URL(incoming.pathname + incoming.search, upstreamOrigin), {
        method: request.method,
        headers,
        body: requestBody,
        redirect: "manual",
      });
    } catch (error) {
      return new Response(String(error), { status: 502 });
    }

    if (debugPath) {
      await Bun.write(debugPath, JSON.stringify({
        url: incoming.pathname + incoming.search,
        requestHeaders: [...headers],
        requestBody: requestBody ? new TextDecoder().decode(requestBody) : null,
        status: upstream.status,
        responseHeaders: [...upstream.headers],
      }) + "\\n");
    }

    const responseHeaders = new Headers(upstream.headers);

    for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) {
      responseHeaders.delete(name);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
});

console.log("READY " + server.port);

const stop = () => {
  server.stop(true);
  process.exit(0);
};

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`;

/** Loopback endpoint of a running proxy. */
interface ProxyEndpoint {
  port: number;
  token: string;
}

/** Options passed to an injected spawn implementation. */
export interface ProxySpawnOptions {
  stdio: ["ignore", "pipe", "pipe"];
  env: NodeJS.ProcessEnv;
}

/** Process surface the transport needs from an injected spawn implementation. */
export interface ProxyProcess {
  readonly stdout: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
  readonly stderr: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Spawns the Bun proxy executable. */
export type ProxySpawn = (
  command: string,
  args: readonly string[],
  options: ProxySpawnOptions,
) => ProxyProcess;

/** Injectable process controls, used by tests to avoid spawning Bun. */
export interface BunTransportOptions {
  /** Bun executable; defaults to the environment override or `bun` on `PATH`. */
  bunPath?: string;
  /** Spawn implementation; defaults to `child_process.spawn`. */
  spawnProcess?: ProxySpawn;
  /** Fetch used for loopback and non-gateway requests; defaults to the global. */
  fetch?: typeof fetch;
}

/** Error raised when the Bun transport cannot start. */
export class BunTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BunTransportError";
  }
}

/**
 * Creates a fetch implementation that sends gateway traffic through Bun.
 *
 * Requests outside `https://opencode.ai/inference/` are passed straight to the
 * supplied fetch, so catalog discovery and version lookups are unaffected and
 * work without Bun. The Bun process starts lazily on the first gateway request
 * and is killed when the host process exits.
 *
 * @param options - Executable path, spawn, and fetch overrides
 * @returns Fetch-compatible function for the OpenCode gateway
 */
export function createBunTransport(options: BunTransportOptions = {}): typeof fetch {
  const bunPath = options.bunPath ?? (process.env[BUN_PATH_ENV]?.trim() || "bun");
  const spawnProcess: ProxySpawn = options.spawnProcess ?? spawn;
  const directFetch = options.fetch ?? globalThis.fetch;
  let endpoint: ProxyEndpoint | undefined;
  let starting: Promise<ProxyEndpoint> | undefined;
  let child: ProxyProcess | undefined;
  let directory: string | undefined;
  let exitHookAttached = false;

  /** Kills the proxy and removes its temporary script; safe to call repeatedly. */
  const stop = (): void => {
    if (exitHookAttached) {
      process.off("exit", stop);
      exitHookAttached = false;
    }

    child?.kill("SIGTERM");
    child = undefined;
    endpoint = undefined;

    if (directory) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Best effort: a leftover script grants nothing without the process token.
      }

      directory = undefined;
    }
  };

  const start = async (): Promise<ProxyEndpoint> => {
    if (!exitHookAttached) {
      process.once("exit", stop);
      exitHookAttached = true;
    }

    // A fresh directory per attempt keeps a retry from reusing a stale script.
    const created = mkdtempSync(join(tmpdir(), "pi-opencode-free-"));
    const script = join(created, "proxy.mjs");
    const token = randomBytes(16).toString("hex");

    directory = created;
    writeFileSync(script, PROXY_SOURCE, { mode: 0o600 });

    const spawned = spawnProcess(bunPath, [script], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_PROXY_TOKEN: token },
    });

    child = spawned;

    try {
      const port = await readReadyPort(spawned);
      const started = { port, token };

      endpoint = started;
      spawned.once("exit", () => {
        if (endpoint === started) endpoint = undefined;
      });

      return started;
    } catch (error) {
      stop();

      throw new BunTransportError(
        `OpenCode Free could not start its Bun transport (${error instanceof Error ? error.message : String(error)}). Install Bun or set ${BUN_PATH_ENV}.`,
      );
    }
  };

  const ensure = (): Promise<ProxyEndpoint> => {
    if (endpoint) return Promise.resolve(endpoint);

    starting ??= start().finally(() => {
      starting = undefined;
    });

    return starting;
  };

  return async (input, init) => {
    const request = input instanceof Request ? input.clone() : new Request(input, init);
    const url = new URL(request.url);

    if (url.origin !== UPSTREAM_ORIGIN || !url.pathname.startsWith(GATEWAY_PATH_PREFIX)) {
      return directFetch(input, init);
    }

    const proxy = await ensure();
    const headers = new Headers(request.headers);

    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();

    for (const name of [
      "host",
      "connection",
      "content-length",
      "keep-alive",
      "proxy-connection",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]) {
      headers.delete(name);
    }

    // Replace any caller-supplied value so only this process can steer the proxy.
    headers.set(TOKEN_HEADER, proxy.token);

    return directFetch(`http://127.0.0.1:${proxy.port}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      signal: request.signal,
    });
  };
}

/**
 * Waits for the proxy to announce its loopback port.
 *
 * @param child - Spawned Bun process
 * @returns Port reported on the first stdout line
 * @throws {Error} If the process exits, errors, or stays silent past the deadline
 */
function readReadyPort(child: ProxyProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    let errors = "";

    const finish = (error: Error | undefined, port?: number): void => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);

      if (error) reject(error);
      else resolve(port ?? 0);
    };

    const timer = setTimeout(() => {
      finish(new Error("timed out waiting for the proxy to start"));
    }, START_TIMEOUT_MS);

    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      finish(new Error(errors.trim() || `Bun exited with code ${code ?? "unknown"}`));
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      errors = `${errors}${chunk.toString("utf8")}`.slice(-2_000);
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");

      const match = /^READY (\d+)$/mu.exec(output);

      if (match?.[1]) finish(undefined, Number(match[1]));
    });
  });
}
