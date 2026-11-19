import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { request as httpsRequest } from "node:https";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createTransport, OPENCODE_CIPHERS } from "../src/transport.ts";

const https = { request: vi.fn() };

// SAFETY: Tests implement the URL, options, callback overload used by the transport.
const send = https.request as typeof httpsRequest;

beforeEach(() => https.request.mockReset());

describe("inference transport", () => {
  it("passes unrelated origins and paths to the supplied fetch unchanged", async () => {
    const fetcher = vi.fn(async () => new Response("direct"));
    const transport = createTransport(fetcher, send);
    const init = { method: "POST", body: "hello" };
    await transport("https://opencode.ai/models", init);
    await transport("https://example.com/inference/test", init);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledWith("https://opencode.ai/models", init);
    expect(https.request).not.toHaveBeenCalled();
  });

  it("streams gateway responses and forwards status, headers and request body", async () => {
    const outgoing = Object.assign(new EventEmitter(), { end: vi.fn() });

    const incoming = Object.assign(new PassThrough(), {
      statusCode: 429,
      statusMessage: "Too Many Requests",
      headers: { "retry-after": "42" },
    });

    https.request.mockImplementation((_url, _options, callback = () => {}) => {
      queueMicrotask(() => callback(incoming));

      return outgoing;
    });

    const pending = createTransport(undefined, send)(
      "https://opencode.ai/inference/openai/v1/chat?x=1",
      {
        method: "POST",
        headers: { connection: "x-remove", "x-remove": "bad" },
        body: "hello",
      },
    );

    const response = await pending;
    incoming.end("refused");
    expect(await response.text()).toBe("refused");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    const [url, options] = https.request.mock.calls[0]!;
    expect(String(url)).toBe("https://opencode.ai/inference/openai/v1/chat?x=1");
    expect(options.ciphers).toBe(OPENCODE_CIPHERS);
    expect(options.headers["x-remove"]).toBeUndefined();
    expect(options.headers["accept-encoding"]).toBe("identity");
    expect(outgoing.end).toHaveBeenCalledWith(Buffer.from("hello"));
  });

  it("shares a keep-alive agent across inference requests and disposes it", async () => {
    https.request.mockImplementation((_url, _options, callback = () => {}) => {
      const outgoing = Object.assign(new EventEmitter(), { end: vi.fn() });

      const incoming = Object.assign(new PassThrough(), {
        statusCode: 200,
        statusMessage: "OK",
        headers: {},
      });

      queueMicrotask(() => {
        callback(incoming);
        incoming.end("ok");
      });

      return outgoing;
    });
    const transport = createTransport(undefined, send);

    for (let index = 0; index < 2; index++) {
      const response = await transport("https://opencode.ai/inference/openai/v1");
      expect(await response.text()).toBe("ok");
    }

    const agent = https.request.mock.calls[0]![1].agent;
    expect(https.request.mock.calls[1]![1].agent).toBe(agent);
    expect(agent.keepAlive).toBe(true);
    expect(agent.options.ciphers).toBe(OPENCODE_CIPHERS);
    const destroy = vi.spyOn(agent, "destroy");
    transport.dispose();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("passes cancellation to HTTPS and destroys the response when its body is cancelled", async () => {
    const outgoing = Object.assign(new EventEmitter(), { end: vi.fn() });

    const incoming = Object.assign(new PassThrough(), {
      statusCode: 200,
      statusMessage: "OK",
      headers: {},
    });

    https.request.mockImplementation((_url, _options, callback = () => {}) => {
      queueMicrotask(() => callback(incoming));

      return outgoing;
    });
    const controller = new AbortController();

    const response = await createTransport(undefined, send)(
      "https://opencode.ai/inference/openai/v1",
      {
        signal: controller.signal,
      },
    );

    const options = https.request.mock.calls[0]![1];
    expect(options.signal.aborted).toBe(false);
    controller.abort();
    expect(options.signal.aborted).toBe(true);
    await response.body?.cancel();
    expect(incoming.destroyed).toBe(true);
  });

  it("does not start an aborted request and forwards transport errors without retries", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      createTransport(undefined, send)("https://opencode.ai/inference/openai/v1", {
        signal: abort.signal,
      }),
    ).rejects.toThrow();
    expect(https.request).not.toHaveBeenCalled();
    const outgoing = Object.assign(new EventEmitter(), { end: vi.fn() });
    https.request.mockImplementation(() => {
      queueMicrotask(() => outgoing.emit("error", new Error("connection lost")));

      return outgoing;
    });
    await expect(
      createTransport(undefined, send)("https://opencode.ai/inference/openai/v1"),
    ).rejects.toThrow("connection lost");
    expect(https.request).toHaveBeenCalledTimes(1);
  });
});
