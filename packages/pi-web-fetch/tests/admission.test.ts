import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vite-plus/test";
import { AcquisitionAdmission } from "../src/acquisition/admission.ts";
import { fetchRemoteContent } from "../src/acquisition/fetch.ts";

describe("acquisition admission", () => {
  it("bounds active acquisitions and waiting callers, handing slots over in order", async () => {
    const admission = new AcquisitionAdmission(1, 2);
    const signal = new AbortController().signal;
    const first = await admission.acquire(signal);
    const second = admission.acquire(signal);
    const third = admission.acquire(signal);
    await expect(admission.acquire(signal)).rejects.toThrow("too many requests");
    first();
    first();
    const releaseSecond = await second;
    let entered = false;
    void third.then(() => {
      entered = true;
    });
    await Promise.resolve();
    expect(entered).toBe(false);
    releaseSecond();
    (await third)();
    (await admission.acquire(signal))();
  });

  it("holds acquisition slots while response bodies are open", async () => {
    const responses: ServerResponse[] = [];

    const server = createServer((_request, response) => {
      responses.push(response);
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("first ");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    // SAFETY: the server is listening on an ephemeral TCP address.
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();

    const dependencies = {
      timeoutMs: 5_000,
      validateUrl: async (value: string | URL) => ({
        url: value instanceof URL ? value : new URL(value),
        address: "127.0.0.1",
        family: 4 as const,
      }),
    };

    const calls = Array.from({ length: 17 }, (_, index) =>
      fetchRemoteContent(
        `http://127.0.0.1:${port}/${index}`,
        0,
        6_000,
        controller.signal,
        dependencies,
      ),
    );

    const results = Promise.all(calls);

    try {
      await vi.waitFor(() => expect(responses).toHaveLength(16));
      responses[0]!.end("done");
      await vi.waitFor(() => expect(responses).toHaveLength(17));
      responses.slice(1).forEach((response) => response.end("done"));
      expect(await results).toHaveLength(17);
    } finally {
      controller.abort();
      await results.catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("releases a slot when cancellation races with a queue handoff", async () => {
    const admission = new AcquisitionAdmission(1, 1);
    const first = await admission.acquire(new AbortController().signal);
    const controller = new AbortController();
    const waiting = admission.acquire(controller.signal);
    first();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    (await admission.acquire(new AbortController().signal))();
  });

  it("removes cancelled waiters and never loses a reserved slot", async () => {
    const admission = new AcquisitionAdmission(1, 1);
    const first = await admission.acquire(new AbortController().signal);
    const controller = new AbortController();
    const waiting = admission.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    const next = admission.acquire(new AbortController().signal);
    first();
    (await next)();
    const aborted = new AbortController();
    aborted.abort();
    await expect(admission.acquire(aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    (await admission.acquire(new AbortController().signal))();
  });
});
