import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vite-plus/test";
import { createBunTransport, type ProxySpawn } from "../src/bun-transport.ts";

const bunAvailable = spawnSync("bun", ["--version"], { timeout: 2_000 }).status === 0;

describe.skipIf(!bunAvailable)("Bun transport integration", () => {
  it.each(["cancel before headers", "cancel", "child exit", "delayed stream", "slow consumer"])(
    "handles %s",
    async (failure) => {
      let terminateChild = () => {};

      let received!: () => void;

      const upstreamReceived = new Promise<void>((resolve) => {
        received = resolve;
      });

      let closed!: () => void;

      const upstreamClosed = new Promise<void>((resolve) => {
        closed = resolve;
      });

      const server = createServer((_request, response) => {
        response.once("close", closed);
        received();

        if (failure !== "cancel before headers") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write("data: first\n\n");

          if (failure === "delayed stream") {
            setTimeout(() => response.end("data: [DONE]\n\n"), 50).unref();
          }

          if (failure === "slow consumer") {
            setTimeout(() => response.end("x".repeat(1024 * 1024)), 50).unref();
          }
        }
      });

      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      // SAFETY: the server is listening on an ephemeral TCP address.
      const port = (server.address() as AddressInfo).port;

      // Change only the test copy of the generated child script; production keeps
      // its fixed upstream. This exercises real Node/Bun sockets without network access.
      const spawnProcess: ProxySpawn = (command, args, options) => {
        const script = args[0]!;

        const source = readFileSync(script, "utf8").replace(
          '"https://opencode.ai"',
          `"http://127.0.0.1:${port}"`,
        );

        writeFileSync(script, source);

        const child = spawn(command, [...args], options);
        terminateChild = () => {
          child.kill("SIGKILL");
        };

        return child;
      };

      const transport = createBunTransport({ spawnProcess });
      const controller = new AbortController();

      try {
        const pending = transport("https://opencode.ai/inference/v1/chat/completions", {
          method: "POST",
          body: "{}",
          signal: controller.signal,
        });

        if (failure === "cancel before headers") {
          await upstreamReceived;
          controller.abort();
          await expect(pending).rejects.toMatchObject({ name: "AbortError" });
          await Promise.race([
            upstreamClosed,
            new Promise<never>((_resolve, reject) =>
              setTimeout(() => reject(new Error("upstream connection not closed")), 2_000).unref(),
            ),
          ]);

          return;
        }

        const response = await pending;
        const reader = response.body!.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");

        if (failure === "slow consumer") {
          await new Promise((resolve) => setTimeout(resolve, 100));
          let bytes = 0;

          for (;;) {
            const chunk = await reader.read();

            if (chunk.done) break;
            bytes += chunk.value.byteLength;
          }

          expect(bytes).toBe(1024 * 1024);

          return;
        }

        if (failure === "delayed stream") {
          const last = await reader.read();
          expect(new TextDecoder().decode(last.value)).toBe("data: [DONE]\n\n");
          expect((await reader.read()).done).toBe(true);

          return;
        }

        if (failure === "cancel") controller.abort();
        else terminateChild();
        const interrupted = reader.read();

        if (failure === "cancel")
          await expect(interrupted).rejects.toMatchObject({ name: "AbortError" });
        else await expect(interrupted).rejects.toThrow();
        await Promise.race([
          upstreamClosed,
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("upstream connection not closed")), 2_000).unref(),
          ),
        ]);
      } finally {
        transport.dispose();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
