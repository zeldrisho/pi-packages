import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vite-plus/test";
import { CLI_NPM_URL, CLI_UPDATE_URL, createCliVersionResolver } from "../src/cli-version";

function updateMetadata(version = "2.1.4") {
  return {
    channel: "latest",
    name: "cli",
    distribution: "npm",
    version,
    active: true,
    metadata: { package: "@opencode/cli" },
  };
}

function npmResponse(version = "2.1.4"): Response {
  return Response.json({ name: "@opencode/cli", version });
}

function deferredResponse() {
  let finish: (response: Response) => void = () => {
    throw new Error("not initialized");
  };

  const promise = new Promise<Response>((resolve) => {
    finish = resolve;
  });

  return { promise, finish: (response: Response) => finish(response) };
}

describe("runtime OpenCode CLI version", () => {
  it("is lazy, uses the installer's fixed metadata endpoint, and caches for 24 hours", async () => {
    let now = 0;
    let calls = 0;

    const resolve = createCliVersionResolver(
      async (input, init) => {
        calls += 1;
        expect(input).toBe(CLI_UPDATE_URL);
        expect(init?.redirect).toBe("error");
        expect(init?.credentials).toBe("omit");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(new Headers(init?.headers).get("authorization")).toBeNull();

        return Response.json(updateMetadata(calls === 1 ? "2.1.4" : "2.2.0"));
      },
      () => now,
    );

    expect(calls).toBe(0);
    expect(await resolve()).toBe("2.1.4");
    expect(await resolve()).toBe("2.1.4");
    now = 24 * 60 * 60 * 1000;
    expect(await resolve()).toBe("2.2.0");
    expect(calls).toBe(2);
  });

  it("falls back to the scoped npm package, without following metadata URLs", async () => {
    const calls: string[] = [];

    const resolve = createCliVersionResolver(async (input) => {
      calls.push(new Request(input).url);

      return input === CLI_UPDATE_URL
        ? Response.json({ ...updateMetadata(), metadata: { package: "https://untrusted.test" } })
        : npmResponse();
    });

    expect(await resolve()).toBe("2.1.4");
    expect(calls).toEqual([CLI_UPDATE_URL, CLI_NPM_URL]);
  });

  it.each([
    null,
    {},
    { ...updateMetadata(), channel: "beta" },
    { ...updateMetadata(), name: "desktop" },
    { ...updateMetadata(), distribution: "binary" },
    { ...updateMetadata(), active: false },
    { ...updateMetadata(), metadata: null },
    { ...updateMetadata(), metadata: "@opencode/cli" },
    { ...updateMetadata(), metadata: {} },
    { ...updateMetadata(), version: 214 },
    { ...updateMetadata(), version: "0.0.0" },
    { ...updateMetadata(), version: "2.1" },
    { ...updateMetadata(), version: "2.1.4-beta" },
    { ...updateMetadata(), version: "02.1.4" },
    { ...updateMetadata(), version: "2.1.4\r\nX-Injected: yes" },
    { ...updateMetadata(), version: "2.1.4\u0000" },
    { ...updateMetadata(), version: `${"2".repeat(33)}.1.4` },
  ])("rejects invalid update metadata: %j", async (metadata) => {
    const resolve = createCliVersionResolver(async (input) =>
      input === CLI_UPDATE_URL ? Response.json(metadata) : npmResponse("2.2.0"),
    );

    expect(await resolve()).toBe("2.2.0");
  });

  it.each([
    null,
    {},
    { name: "opencode-ai", version: "1.19.4" },
    { name: "@opencode/cli", version: "2.1.4-beta" },
    { name: "@opencode/cli", version: "2.1.4\r\nInjected: yes" },
  ])("fails clearly when neither source supplies a valid version: %j", async (metadata) => {
    const resolve = createCliVersionResolver(async (input) =>
      input === CLI_UPDATE_URL
        ? new Response("unavailable", { status: 503 })
        : Response.json(metadata),
    );

    await expect(resolve()).rejects.toThrow("Cannot resolve the current OpenCode CLI version");
  });

  it.each([302, 404, 429, 500])("falls back on HTTP %s", async (status) => {
    const resolve = createCliVersionResolver(async (input) =>
      input === CLI_UPDATE_URL ? new Response("unavailable", { status }) : npmResponse(),
    );

    expect(await resolve()).toBe("2.1.4");
  });

  it.each(["network", "timeout"])("falls back on a source %s failure", async (kind) => {
    const resolve = createCliVersionResolver(async (input) => {
      if (input === CLI_UPDATE_URL) {
        throw kind === "timeout"
          ? new DOMException("timeout", "TimeoutError")
          : new Error("network");
      }

      return npmResponse();
    });

    expect(await resolve()).toBe("2.1.4");
  });

  it("does not cache failures or serve an expired version after a failed refresh", async () => {
    let now = 0;
    let failed = false;

    const resolve = createCliVersionResolver(
      async () => {
        if (failed) throw new Error("offline");

        return Response.json(updateMetadata());
      },
      () => now,
    );

    expect(await resolve()).toBe("2.1.4");
    now = 24 * 60 * 60 * 1000;
    failed = true;
    await expect(resolve()).rejects.toThrow("Cannot resolve");
    failed = false;
    expect(await resolve()).toBe("2.1.4");
  });

  it("shares concurrent lookups while preserving independent cancellation", async () => {
    const response = deferredResponse();
    let calls = 0;
    let sourceSignal: AbortSignal | null | undefined;

    const resolve = createCliVersionResolver(async (_input, init) => {
      calls += 1;
      sourceSignal = init?.signal;

      return response.promise;
    });

    const controller = new AbortController();
    const first = resolve(controller.signal);
    const second = resolve();
    controller.abort(new Error("first canceled"));
    await expect(first).rejects.toThrow("first canceled");
    expect(sourceSignal?.aborted).toBe(false);
    response.finish(Response.json(updateMetadata()));
    expect(await second).toBe("2.1.4");
    expect(calls).toBe(1);
  });

  it("aborts the underlying lookup when its last waiter cancels and allows a new lookup", async () => {
    let calls = 0;
    let sourceSignal: AbortSignal | null | undefined;

    const resolve = createCliVersionResolver(async (_input, init) => {
      calls += 1;
      sourceSignal = init?.signal;

      if (calls > 1) return Response.json(updateMetadata("2.2.0"));

      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });

    const controller = new AbortController();
    const first = resolve(controller.signal);
    controller.abort();
    await expect(first).rejects.toThrow();
    expect(sourceSignal?.aborted).toBe(true);
    expect(await resolve()).toBe("2.2.0");
    expect(calls).toBe(2);
  });

  it("does not let a late canceled response replace a newer cached version", async () => {
    const late = deferredResponse();
    let calls = 0;

    const resolve = createCliVersionResolver(async () => {
      calls += 1;

      return calls === 1 ? late.promise : Response.json(updateMetadata("2.2.0"));
    });

    const controller = new AbortController();
    const first = resolve(controller.signal);
    controller.abort();
    await expect(first).rejects.toThrow();
    expect(await resolve()).toBe("2.2.0");
    late.finish(Response.json(updateMetadata("2.1.4")));
    await new Promise<void>((done) => setImmediate(done));
    expect(await resolve()).toBe("2.2.0");
    expect(calls).toBe(2);
  });

  it("times out a stalled metadata body before falling back", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
    });

    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    // SAFETY: listen() above binds a TCP socket, so its address is an AddressInfo.
    const address = server.address() as AddressInfo;
    let timedOut = false;

    const resolve = createCliVersionResolver(async (input, init) => {
      if (input === CLI_NPM_URL) return npmResponse();

      init?.signal?.addEventListener(
        "abort",
        () => {
          timedOut = true;
        },
        { once: true },
      );

      return await fetch(`http://127.0.0.1:${address.port}`, init);
    });

    try {
      expect(await resolve()).toBe("2.1.4");
      expect(timedOut).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    }
  }, 15_000);

  it("does not fetch or return cached data for an already canceled caller", async () => {
    let calls = 0;

    const resolve = createCliVersionResolver(async () => {
      calls += 1;

      return Response.json(updateMetadata());
    });

    const controller = new AbortController();
    controller.abort();
    await expect(resolve(controller.signal)).rejects.toThrow();
    expect(calls).toBe(0);
    await resolve();
    await expect(resolve(controller.signal)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("cancels oversized streamed metadata before falling back", async () => {
    let canceled = false;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        canceled = true;
      },
    });

    const resolve = createCliVersionResolver(async (input) =>
      input === CLI_UPDATE_URL ? new Response(body) : npmResponse(),
    );

    expect(await resolve()).toBe("2.1.4");
    expect(canceled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it.each(["json", "utf8", "empty", "read"])("falls back on invalid %s bodies", async (kind) => {
    const resolve = createCliVersionResolver(async (input) => {
      if (input === CLI_NPM_URL) return npmResponse();

      if (kind === "json") return new Response("{");

      if (kind === "utf8") return new Response(new Uint8Array([0xff]));

      if (kind === "empty") return new Response(null);

      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("body read failed"));
          },
        }),
      );
    });

    expect(await resolve()).toBe("2.1.4");
  });
});
