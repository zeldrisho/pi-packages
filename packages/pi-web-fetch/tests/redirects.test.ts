import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  fetchRemoteContent,
  requestPinned,
  validateRemoteUrl,
  type FetchRemoteDependencies,
  type ValidatedTarget,
} from "../src/index";
import { createFetchHarness } from "./harness";
import { requestFollowingRedirects } from "../src/network/network-redirects.ts";

describe("web_fetch redirects", () => {
  const fixture = createFetchHarness();
  let origin = "";
  let dependencies: FetchRemoteDependencies;

  beforeAll(async () => {
    await fixture.start();
    origin = fixture.origin();
    dependencies = fixture.dependencies();
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it("revalidates and repins every redirect", async () => {
    const validated: string[] = [];
    const requested: ValidatedTarget[] = [];

    const result = await fetchRemoteContent(`${origin}/redirect`, 0, 6_000, undefined, {
      validateUrl: async (value) => {
        const url = value instanceof URL ? value : new URL(value);
        validated.push(url.pathname);

        return { url, address: "127.0.0.1", family: 4 };
      },
      request: async (target, signal) => {
        requested.push(target);

        return await requestPinned(target, signal);
      },
    });

    expect(validated).toEqual(["/redirect", "/html"]);
    expect(requested.map((target) => target.url.pathname)).toEqual(["/redirect", "/html"]);
    expect(requested[1]).not.toBe(requested[0]);
    expect(result.url).toBe(`${origin}/html`);
  });

  it("rejects a redirect to a blocked target before requesting it", async () => {
    const requested: string[] = [];
    await expect(
      fetchRemoteContent(`${origin}/redirect-blocked`, 0, 6_000, undefined, {
        validateUrl: async (value) => {
          const url = value instanceof URL ? value : new URL(value);

          if (url.pathname === "/redirect-blocked") {
            return { url, address: "127.0.0.1", family: 4 };
          }

          return await validateRemoteUrl(url);
        },
        request: async (target, signal) => {
          requested.push(target.url.pathname);

          return await requestPinned(target, signal);
        },
      }),
    ).rejects.toThrow("private or reserved");
    expect(requested).toEqual(["/redirect-blocked"]);
  });

  it.each([302, 500])("closes a stalled discarded HTTP %i body", async (status) => {
    let closed!: () => void;

    const disconnected = new Promise<void>((resolve) => {
      closed = resolve;
    });

    const server = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "text/plain" });
      response.write("unfinished");
      response.once("close", closed);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    // SAFETY: the server is listening on an ephemeral TCP address.
    const port = (server.address() as AddressInfo).port;

    try {
      await expect(
        fetchRemoteContent(`http://127.0.0.1:${port}/discard`, 0, 6_000, undefined, {
          validateUrl: async (value) => ({
            url: value instanceof URL ? value : new URL(value),
            address: "127.0.0.1",
            family: 4,
          }),
        }),
      ).rejects.toThrow();
      await Promise.race([
        disconnected,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("discarded body remained open")), 2_000).unref(),
        ),
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("allows distinct requests to complete header coordination while earlier bodies remain open", async () => {
    let active = 0;
    let maximum = 0;

    const server = createServer((_request, response) => {
      active += 1;
      maximum = Math.max(maximum, active);
      response.once("close", () => {
        active -= 1;
      });
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("pending");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    // SAFETY: the server is listening on an ephemeral TCP address.
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();

    const dependencies = {
      validateUrl: async (value: string | URL): Promise<ValidatedTarget> => ({
        url: value instanceof URL ? value : new URL(value),
        address: "127.0.0.1",
        family: 4,
      }),
    };

    try {
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          requestFollowingRedirects(
            `http://127.0.0.1:${port}/${index}`,
            controller.signal,
            dependencies,
          ),
        ),
      );

      expect(maximum).toBe(6);
      responses.forEach(({ response }) => response.destroy());
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("enforces redirect limits", async () => {
    await expect(
      fetchRemoteContent(`${origin}/redirect-loop`, 0, 6_000, undefined, dependencies),
    ).rejects.toThrow("too many redirects");
  });
});
