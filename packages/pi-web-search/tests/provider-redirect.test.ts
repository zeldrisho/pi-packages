import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vite-plus/test";
import { requestText } from "../src/provider.ts";

describe("provider redirect boundary", () => {
  it("never forwards a subscription token to a redirected origin", async () => {
    let redirected = false;

    const target = createServer((_request, response) => {
      redirected = true;
      response.end("unexpected");
    });

    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    // SAFETY: target listens on an ephemeral TCP address.
    const targetPort = (target.address() as AddressInfo).port;

    const source = createServer((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${targetPort}/` });
      response.end();
    });

    source.listen(0, "127.0.0.1");
    await once(source, "listening");
    // SAFETY: source listens on an ephemeral TCP address.
    const sourcePort = (source.address() as AddressInfo).port;

    try {
      await expect(
        requestText(
          `http://127.0.0.1:${sourcePort}/`,
          {
            headers: { "X-Subscription-Token": "fixture-secret" },
            redirect: "follow",
          },
          undefined,
        ),
      ).rejects.toThrow();
      expect(redirected).toBe(false);
    } finally {
      source.closeAllConnections();
      target.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => source.close(() => resolve())),
        new Promise<void>((resolve) => target.close(() => resolve())),
      ]);
    }
  });
});
