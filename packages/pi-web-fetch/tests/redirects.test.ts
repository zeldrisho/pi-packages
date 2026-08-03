import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  fetchRemoteContent,
  requestPinned,
  validateRemoteUrl,
  type FetchRemoteDependencies,
  type ValidatedTarget,
} from "../src/index";
import { createFetchHarness } from "./harness";

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

  it("enforces redirect limits", async () => {
    await expect(
      fetchRemoteContent(`${origin}/redirect-loop`, 0, 6_000, undefined, dependencies),
    ).rejects.toThrow("too many redirects");
  });
});
