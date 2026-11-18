import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CONSUMER_CLIENT, discoverAgyClient } from "../src/agy-client";
import { BUNDLED_CLIENT, resolveOAuthClient } from "../src/oauth-client";

vi.mock("../src/agy-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/agy-client")>();

  return { ...original, discoverAgyClient: vi.fn(async () => undefined) };
});

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

afterEach(() => {
  vi.mocked(discoverAgyClient).mockReset().mockResolvedValue(undefined);
  vi.unstubAllEnvs();
});

describe("bundled OAuth client", () => {
  it("matches the fingerprints independently published by agy-auth", () => {
    expect(hash(BUNDLED_CLIENT.id)).toBe(CONSUMER_CLIENT.id);
    expect(CONSUMER_CLIENT.secrets).toContain(hash(BUNDLED_CLIENT.secret));
  });

  it("resolves without any installed CLI", async () => {
    vi.stubEnv("PATH", "");

    expect(await resolveOAuthClient()).toEqual(BUNDLED_CLIENT);
  });

  it("prefers the installed CLI client so a rotated client keeps working", async () => {
    const rotated = { id: "rotated-id", secret: "rotated-secret" };
    vi.mocked(discoverAgyClient).mockResolvedValueOnce(rotated);

    expect(await resolveOAuthClient()).toEqual(rotated);
  });

  it("honors cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(resolveOAuthClient(controller.signal)).rejects.toThrow("cancelled");
  });
});
