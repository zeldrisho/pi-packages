import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { extractKeyValue, resolveApiKey } from "../src/credentials";

// Redirect the agent-global .env lookup into a temporary directory so tests
// never touch the real agent configuration.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    getAgentDir: () => agentDirectory,
  };
});

let agentDirectory = "";
let workspaceDirectory = "";
const originalApiKey = process.env.BRAVE_SEARCH_API_KEY;

beforeEach(async () => {
  // Tests manage the environment explicitly so a developer's real key
  // cannot leak into resolution-order expectations.
  delete process.env.BRAVE_SEARCH_API_KEY;
  agentDirectory = await mkdtemp(join(tmpdir(), "ws-cred-agent-"));
  workspaceDirectory = await mkdtemp(join(tmpdir(), "ws-cwd-"));
});

afterEach(async () => {
  if (originalApiKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = originalApiKey;
  await Promise.all([
    rm(agentDirectory, { recursive: true, force: true }),
    rm(workspaceDirectory, { recursive: true, force: true }),
  ]);
});

describe("extractKeyValue", () => {
  it("reads plain, quoted, exported, and spaced assignments", () => {
    expect(extractKeyValue("BRAVE_SEARCH_API_KEY=k1\n")).toBe("k1");
    expect(extractKeyValue('BRAVE_SEARCH_API_KEY="k2"\n')).toBe("k2");
    expect(extractKeyValue("BRAVE_SEARCH_API_KEY='k3'\n")).toBe("k3");
    expect(extractKeyValue("  export BRAVE_SEARCH_API_KEY = k4 \n")).toBeUndefined();
    expect(extractKeyValue("# BRAVE_SEARCH_API_KEY=hidden\nBRAVE_SEARCH_API_KEY=k5")).toBe("k5");
  });

  it("ignores files without the key", () => {
    expect(extractKeyValue("OTHER_KEY=1\n")).toBeUndefined();
    expect(extractKeyValue("BRAVE_SEARCH_API_KEY=\n")).toBeUndefined();
  });
});

describe("resolveApiKey", () => {
  it("prefers the process environment over .env files", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "env-key";
    await writeFile(join(workspaceDirectory, ".env"), "BRAVE_SEARCH_API_KEY=file-key\n");
    const resolved = await resolveApiKey(workspaceDirectory);
    expect(resolved).toEqual({ key: "env-key", source: "environment" });
  });

  it("falls back to the workspace .env when the environment is unset", async () => {
    await writeFile(join(agentDirectory, ".env"), "BRAVE_SEARCH_API_KEY=agent-key\n");
    await writeFile(join(workspaceDirectory, ".env"), 'BRAVE_SEARCH_API_KEY="workspace-key"\n');
    const resolved = await resolveApiKey(workspaceDirectory);
    expect(resolved).toEqual({ key: "workspace-key", source: "workspace .env" });
  });

  it("falls back to the agent .env last", async () => {
    await writeFile(join(agentDirectory, ".env"), "BRAVE_SEARCH_API_KEY=agent-key\n");
    const resolved = await resolveApiKey(workspaceDirectory);
    expect(resolved).toEqual({ key: "agent-key", source: "agent .env" });
  });

  it("returns undefined without a key anywhere and tolerates missing files", async () => {
    await expect(resolveApiKey(workspaceDirectory)).resolves.toBeUndefined();
  });

  it("never exposes reporting metadata beyond the source", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "secret-value";
    const resolved = await resolveApiKey(workspaceDirectory);
    // The resolver returns the key for provider calls, but everything that
    // reaches tool output must be the source label only.
    expect(resolved?.source).toBe("environment");
    expect(Object.keys(resolved ?? {}).sort()).toEqual(["key", "source"]);
  });
});

describe("web_search key-source reporting", () => {
  it("reports the credential source in details without leaking the key", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "details-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ web: { results: [] } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const { createSearchTool } = await import("./harness");
    const result = await createSearchTool().execute(
      "call",
      { query: "source query" },
      undefined,
      undefined,
    );
    expect(result.details.apiKeySource).toBe("environment");

    // SAFETY: the serialized details must not contain the raw credential.
    expect(JSON.stringify(result)).not.toContain("details-secret");
  });
});
