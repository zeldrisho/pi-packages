import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { discoverAgyClient } from "../src/agy-client";
import { loginAntigravity, refreshCredentials, redirectUri, TOKEN_URL } from "../src/oauth";

vi.mock("../src/agy-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/agy-client")>();

  return { ...original, discoverAgyClient: vi.fn() };
});

const credentials = { access: "old", refresh: "refresh", expires: 1, projectId: "project" };

beforeEach(() => {
  vi.mocked(discoverAgyClient)
    .mockReset()
    .mockResolvedValue({ id: "test-client-id", secret: "test-client-secret" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: the listening TCP server has an address with a numeric port.
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

  return port;
}

async function redirect(): Promise<string> {
  const url = `http://localhost:${await freePort()}/oauth-callback`;
  vi.stubEnv("PI_ANTIGRAVITY_REDIRECT_URI", url);

  return url;
}

function callbacks(onPrompt: OAuthLoginCallbacks["onPrompt"]): OAuthLoginCallbacks {
  return {
    onAuth: vi.fn(),
    onPrompt,
    onProgress: vi.fn(),
    onDeviceCode: vi.fn(),
    onSelect: vi.fn(),
  };
}

function loginFetch(tokenResponse: Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === TOKEN_URL
        ? tokenResponse
        : Response.json({ cloudaicompanionProject: "project-live" }),
    ),
  );
}

describe("OAuth login", () => {
  it("uses the bundled client when no CLI is found", async () => {
    await redirect();
    loginFetch(
      Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
    );
    vi.mocked(discoverAgyClient).mockResolvedValueOnce(undefined);
    const onAuth = vi.fn();
    const onPrompt = vi.fn().mockResolvedValue("code=abc&state=state");
    const interaction = { ...callbacks(onPrompt), onAuth };

    const result = await loginAntigravity(interaction, { newState: () => "state" });

    expect(result.access).toBe("access");
    expect(onAuth).toHaveBeenCalledOnce();
  });

  it("exchanges a pasted callback and discovers the project", async () => {
    await redirect();
    loginFetch(
      Response.json({ access_token: "access", refresh_token: "refresh-new", expires_in: 3600 }),
    );

    const onPrompt = vi
      .fn()
      .mockResolvedValueOnce("invalid")
      .mockResolvedValueOnce("code=abc&state=state");

    const result = await loginAntigravity(callbacks(onPrompt), {
      now: () => 1000,
      newState: () => "state",
    });

    expect(result).toEqual({
      access: "access",
      refresh: "refresh-new",
      expires: 3301000,
      projectId: "project-live",
    });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      TOKEN_URL,
      expect.objectContaining({ redirect: "error" }),
    );
    expect(onPrompt).toHaveBeenCalledTimes(2);
    expect(onPrompt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        placeholder: "http://localhost:51121/oauth-callback?state=…&code=…",
      }),
    );
  });

  it.each([
    [
      "provider error",
      () => Response.json({ error: "invalid_grant", error_description: "denied" }, { status: 400 }),
      /invalid_grant: denied/,
    ],
    ["plain error", () => new Response("failure", { status: 400 }), /failure/],
    ["empty error", () => new Response("", { status: 400 }), /unknown OAuth error/],
    ["missing access", () => Response.json({ expires_in: 3600 }), /unexpected response/],
    [
      "invalid expiry",
      () => Response.json({ access_token: "token", expires_in: 0 }),
      /unexpected response/,
    ],
    [
      "bad refresh",
      () => Response.json({ access_token: "token", expires_in: 3600, refresh_token: 42 }),
      /unexpected response/,
    ],
    [
      "missing refresh",
      () => Response.json({ access_token: "token", expires_in: 3600 }),
      /did not return a refresh token/,
    ],
  ])("rejects %s", async (_label, response, expected) => {
    await redirect();
    loginFetch(response());
    await expect(
      loginAntigravity(
        callbacks(async () => "code=abc&state=state"),
        { newState: () => "state" },
      ),
    ).rejects.toThrow(expected);
  });

  it("fails cleanly when the callback port is occupied", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: the listening TCP server has an address with a numeric port.
    const port = (server.address() as AddressInfo).port;
    vi.stubEnv("PI_ANTIGRAVITY_REDIRECT_URI", `http://localhost:${port}/oauth-callback`);

    try {
      await expect(
        loginAntigravity(
          callbacks(() => new Promise(() => {})),
          { newState: () => "state" },
        ),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("accepts a loopback callback without returning its code in HTML", async () => {
    const uri = await redirect();
    loginFetch(
      Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
    );
    let html = "";
    const interaction = callbacks(() => new Promise(() => {}));
    interaction.onAuth = () => {
      get(uri.replace("localhost", "127.0.0.1") + "?code=secret-code&state=state", (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          html += chunk;
        });
      });
    };

    await expect(loginAntigravity(interaction, { newState: () => "state" })).resolves.toMatchObject(
      { access: "access" },
    );
    expect(html).not.toContain("secret-code");
  });

  it("ignores an invalid callback and accepts a subsequent valid callback", async () => {
    const uri = (await redirect()).replace("localhost", "127.0.0.1");
    loginFetch(
      Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
    );
    const interaction = callbacks(() => new Promise(() => {}));
    interaction.onAuth = () => {
      get(uri + "?error=denied&state=other", (response) => {
        expect(response.statusCode).toBe(400);
        response.resume();
        get(uri + "?code=secret&state=state", (valid) => valid.resume());
      });
    };

    await expect(loginAntigravity(interaction, { newState: () => "state" })).resolves.toMatchObject(
      { access: "access" },
    );
  });

  it("cancels an already aborted login", async () => {
    await redirect();
    const controller = new AbortController();
    controller.abort();

    const interaction = {
      ...callbacks(() => new Promise<string>(() => {})),
      signal: controller.signal,
    };

    await expect(loginAntigravity(interaction)).rejects.toThrow(/cancelled/);
  });
});

describe("OAuth refresh", () => {
  it("uses the discovered client and retains the project on refresh", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ access_token: "new", expires_in: 3600 }),
    );

    vi.stubGlobal("fetch", fetch);
    expect(await refreshCredentials(credentials, undefined, 1000)).toEqual({
      ...credentials,
      access: "new",
      expires: 3301000,
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      TOKEN_URL,
      expect.objectContaining({ redirect: "error" }),
    );
    const rawBody = fetch.mock.calls[0]?.[1].body;

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the request boundary must send a form-encoded string
    if (typeof rawBody !== "string") throw new Error("expected a form-encoded request body");
    const body = new URLSearchParams(rawBody);
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("client_secret")).toBe("test-client-secret");
  });
  it("accepts a rotated refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 3600 }),
      ),
    );
    expect((await refreshCredentials(credentials, undefined, 0)).refresh).toBe("rotated");
  });
  it("rejects malformed and refused responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "revoked" }, { status: 401 })),
    );
    await expect(refreshCredentials(credentials, undefined, 0)).rejects.toThrow(/revoked/);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ access_token: "", expires_in: 1 })),
    );
    await expect(refreshCredentials(credentials, undefined, 0)).rejects.toThrow(
      /unexpected response/,
    );
  });
  it("uses the registered loopback URI when the override is blank", () => {
    vi.stubEnv("PI_ANTIGRAVITY_REDIRECT_URI", " ");
    expect(redirectUri()).toBe("http://localhost:51121/oauth-callback");
  });

  it("accepts a trimmed redirect URI override", () => {
    vi.stubEnv("PI_ANTIGRAVITY_REDIRECT_URI", " http://localhost:1234/oauth-callback ");
    expect(redirectUri()).toBe("http://localhost:1234/oauth-callback");
  });
});
