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

const originalAnswersApiKey = process.env.BRAVE_ANSWERS_API_KEY;

beforeEach(async () => {
  // Tests manage the environment explicitly so a developer's real key
  // cannot leak into resolution-order expectations.
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BRAVE_ANSWERS_API_KEY;
  agentDirectory = await mkdtemp(join(tmpdir(), "ws-cred-agent-"));
  workspaceDirectory = await mkdtemp(join(tmpdir(), "ws-cwd-"));
});

afterEach(async () => {
  if (originalApiKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = originalApiKey;

  if (originalAnswersApiKey === undefined) delete process.env.BRAVE_ANSWERS_API_KEY;
  else process.env.BRAVE_ANSWERS_API_KEY = originalAnswersApiKey;
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
  it("resolves the web key in precedence order as each source is removed", async () => {
    const workspaceEnv = join(workspaceDirectory, ".env");
    const agentEnv = join(agentDirectory, ".env");
    process.env.BRAVE_SEARCH_API_KEY = "env-key";
    await writeFile(workspaceEnv, 'BRAVE_SEARCH_API_KEY="workspace-key"\n');
    await writeFile(agentEnv, "BRAVE_SEARCH_API_KEY=agent-key\n");

    expect(await resolveApiKey(workspaceDirectory)).toEqual({
      key: "env-key",
      source: "environment",
    });
    delete process.env.BRAVE_SEARCH_API_KEY;
    expect(await resolveApiKey(workspaceDirectory)).toEqual({
      key: "workspace-key",
      source: "workspace .env",
    });
    await rm(workspaceEnv);
    expect(await resolveApiKey(workspaceDirectory)).toEqual({
      key: "agent-key",
      source: "agent .env",
    });
    await rm(agentEnv);
    await expect(resolveApiKey(workspaceDirectory)).resolves.toBeUndefined();
  });
});

describe("Answers key resolution", () => {
  it("selects only the named key from .env text", () => {
    const text = 'BRAVE_SEARCH_API_KEY=web-key\nBRAVE_ANSWERS_API_KEY="answers-key"\n';
    expect(extractKeyValue(text, "BRAVE_ANSWERS_API_KEY")).toBe("answers-key");
    expect(extractKeyValue(text)).toBe("web-key");
  });

  it("resolves Answers environment, workspace, and agent keys in order", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "web-key";
    process.env.BRAVE_ANSWERS_API_KEY = "answers-env";
    await writeFile(
      join(workspaceDirectory, ".env"),
      "BRAVE_SEARCH_API_KEY=web-workspace\nBRAVE_ANSWERS_API_KEY=answers-workspace\n",
    );
    await writeFile(join(agentDirectory, ".env"), "BRAVE_ANSWERS_API_KEY=answers-agent\n");
    expect(await resolveApiKey(workspaceDirectory, "BRAVE_ANSWERS_API_KEY")).toEqual({
      key: "answers-env",
      source: "environment",
    });
    delete process.env.BRAVE_ANSWERS_API_KEY;
    expect(await resolveApiKey(workspaceDirectory, "BRAVE_ANSWERS_API_KEY")).toEqual({
      key: "answers-workspace",
      source: "workspace .env",
    });
    await rm(join(workspaceDirectory, ".env"));
    expect(await resolveApiKey(workspaceDirectory, "BRAVE_ANSWERS_API_KEY")).toEqual({
      key: "answers-agent",
      source: "agent .env",
    });
  });

  it("does not reuse the web key and fails before any request", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "web-only";
    await writeFile(join(workspaceDirectory, ".env"), "BRAVE_SEARCH_API_KEY=workspace-web-only\n");
    await writeFile(join(agentDirectory, ".env"), "BRAVE_SEARCH_API_KEY=agent-web-only\n");
    expect(await resolveApiKey(workspaceDirectory, "BRAVE_ANSWERS_API_KEY")).toBeUndefined();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { createSearchTool } = await import("./harness");
    await expect(
      createSearchTool().execute(
        "call",
        { query: "missing Answers key", mode: "answers" },
        undefined,
        undefined,
        { cwd: workspaceDirectory },
      ),
    ).rejects.toThrow("BRAVE_ANSWERS_API_KEY is required for answers mode");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a web key even when an Answers key is set", async () => {
    process.env.BRAVE_ANSWERS_API_KEY = "answers-only";
    expect(await resolveApiKey(workspaceDirectory)).toBeUndefined();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { createSearchTool } = await import("./harness");

    await expect(
      createSearchTool().execute("call", { query: "missing web key" }, undefined, undefined, {
        cwd: workspaceDirectory,
      }),
    ).rejects.toThrow("BRAVE_SEARCH_API_KEY is required");
    expect(fetchMock).not.toHaveBeenCalled();
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
