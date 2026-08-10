import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createReleaseAutomation,
  runReleaseCli,
  type CommandAttempt,
  type CommandRunner,
  type ReleaseAutomation,
  type ReleasePlanner,
} from "./release";

const temporaryDirectories: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function createRepository(version = "1.0.0"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "release-repository-test-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "packages", "alpha"), { recursive: true });
  await writeFile(
    join(root, "packages", "alpha", "package.json"),
    `${JSON.stringify({ name: "@zeldrisho/alpha", version }, null, 2)}\n`,
  );
  await writeFile(join(root, "packages", "alpha", "CHANGELOG.md"), "# Changelog\n");
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "release-test@example.test");
  git(root, "config", "user.name", "Release Test");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "feat: initial package");
  return root;
}

async function commit(root: string, subject: string, body?: string): Promise<void> {
  const marker = join(root, "packages", "alpha", "marker.txt");
  await writeFile(marker, `${subject}\n${body ?? ""}\n${crypto.randomUUID()}\n`);
  git(root, "add", ".");
  const args = ["commit", "--quiet", "-m", subject];
  if (body) args.push("-m", body);
  git(root, ...args);
}

interface FakeServices {
  npm?: CommandAttempt;
  github?: CommandAttempt;
  nextTag?: string;
  failCreate?: boolean;
  failPlan?: boolean;
  plannerCalls: number;
  calls: Array<{ command: string; args: string[] }>;
}

function runnerFor(root: string, services: FakeServices): CommandRunner {
  return {
    run(command, args) {
      services.calls.push({ command, args });
      if (command === "git") return git(root, ...args);
      if (command === "gh") {
        if (services.failCreate) throw new Error("GitHub create failed");
        return "";
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    attempt(command, args) {
      services.calls.push({ command, args });
      if (command === "git") {
        try {
          return { status: 0, stdout: git(root, ...args), stderr: "" };
        } catch {
          return { status: 1, stdout: "", stderr: "not found" };
        }
      }
      if (command === "vp") {
        return (
          services.npm ?? {
            status: 1,
            stdout: JSON.stringify({ error: { code: "ERR_PNPM_NO_MATCHING_VERSION" } }),
            stderr: "",
          }
        );
      }
      if (command === "gh") {
        return services.github ?? { status: 1, stdout: "", stderr: "HTTP 404" };
      }
      throw new Error(`Unexpected attempted command: ${command}`);
    },
  };
}

function services(overrides: Partial<FakeServices> = {}): FakeServices {
  return { calls: [], plannerCalls: 0, ...overrides };
}

function plannerFor(state: FakeServices): ReleasePlanner {
  return {
    async plan(_pkg, requestedVersion) {
      state.plannerCalls += 1;
      if (state.failPlan) throw new Error("Changelog generation failed");
      const tag = requestedVersion
        ? `alpha-v${requestedVersion}`
        : (state.nextTag ?? "alpha-v1.0.1");
      const version = tag.slice("alpha-v".length);
      return { version, tag, notes: "## generated\n\nGenerated release notes" };
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("release planning", () => {
  it("orders component tags semantically and rejects manifest/tag inconsistencies", async () => {
    const root = await createRepository("1.5.0");
    for (const tag of ["alpha-v1.2.0", "alpha-v1.10.0", "alpha-v1.5.0", "alpha-vbad"]) {
      git(root, "tag", tag);
    }
    const state = services();
    const automation = createReleaseAutomation({ root, runner: runnerFor(root, state) });
    const pkg = (await automation.packageCatalog())[0];

    expect(automation.componentTags(pkg)).toEqual([
      "alpha-v1.10.0",
      "alpha-v1.5.0",
      "alpha-v1.2.0",
    ]);
    expect(() => automation.assertCurrentVersionIsLatest(pkg)).toThrow(
      "inconsistent with latest component tag alpha-v1.10.0",
    );
  });

  it("treats package directories literally in component tag patterns", () => {
    const runner: CommandRunner = {
      run: () => "a.b-v1.2.0\naxb-v1.3.0",
      attempt: () => ({ status: 1, stdout: "", stderr: "" }),
    };
    const automation = createReleaseAutomation({ runner });
    const pkg = {
      directory: "a.b",
      path: "packages/a.b",
      manifestPath: "packages/a.b/package.json",
      changelogPath: "packages/a.b/CHANGELOG.md",
      name: "@zeldrisho/a.b",
      version: "1.2.0",
      tag: "a.b-v1.2.0",
    };

    expect(automation.componentTags(pkg)).toEqual(["a.b-v1.2.0"]);
  });

  it.each([
    ["docs: explain alpha", undefined, false],
    ["fix: repair alpha", undefined, true],
    ["chore: reorganize alpha", "BREAKING CHANGE: remove old behavior", true],
  ] as const)("classifies %s commits", async (subject, body, expected) => {
    const root = await createRepository();
    git(root, "tag", "alpha-v1.0.0");
    await commit(root, subject, body);
    const state = services();
    const automation = createReleaseAutomation({ root, runner: runnerFor(root, state) });

    expect(automation.hasReleasableChanges((await automation.packageCatalog())[0])).toBe(expected);
  });

  it("generates versions, changelogs, and the release pull-request body", async () => {
    const root = await createRepository();
    git(root, "tag", "alpha-v1.0.0");
    await commit(root, "fix: repair alpha");
    const bodyPath = join(root, "release-body.md");
    const state = services({ nextTag: "alpha-v1.0.1" });
    const messages: string[] = [];
    const automation = createReleaseAutomation({
      root,
      runner: runnerFor(root, state),
      planner: plannerFor(state),
      env: { RELEASE_PR_BODY: bodyPath },
      log: (message) => messages.push(message),
    });

    await automation.prepare();

    expect(
      JSON.parse(await readFile(join(root, "packages/alpha/package.json"), "utf8")),
    ).toMatchObject({
      version: "1.0.1",
    });
    expect(await readFile(join(root, "packages/alpha/CHANGELOG.md"), "utf8")).toContain(
      "## generated",
    );
    expect(await readFile(bodyPath, "utf8")).toContain("`@zeldrisho/alpha` → `1.0.1`");
    expect(messages).toEqual(["Prepared 1 package release(s): alpha-v1.0.1"]);
  });

  it("runs semantic-release against package-local component tags", async () => {
    const root = await createRepository();
    git(root, "branch", "-M", "main");
    git(root, "tag", "alpha-v1.0.0");
    await commit(root, "fix(alpha): repair behavior");
    await writeFile(join(root, "unrelated.txt"), "unrelated feature\n");
    git(root, "add", "unrelated.txt");
    git(root, "commit", "--quiet", "-m", "feat: unrelated behavior");
    const remote = await mkdtemp(join(tmpdir(), "release-remote-test-"));
    temporaryDirectories.push(remote);
    git(remote, "init", "--bare", "--quiet");
    git(root, "remote", "add", "origin", remote);
    git(root, "push", "--quiet", "--set-upstream", "origin", "main", "--tags");
    git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
    await mkdir(join(root, "scripts"));
    await writeFile(
      join(root, "scripts/semantic-release-plugin.ts"),
      await readFile(join(process.cwd(), "scripts/semantic-release-plugin.ts"), "utf8"),
    );
    const messages: string[] = [];
    const automation = createReleaseAutomation({
      root,
      log: (message) => messages.push(message),
    });

    await automation.prepare();

    expect(
      JSON.parse(await readFile(join(root, "packages/alpha/package.json"), "utf8")),
    ).toMatchObject({ version: "1.0.1" });
    expect(await readFile(join(root, "packages/alpha/CHANGELOG.md"), "utf8")).toContain(
      "### Bug fixes",
    );
    expect(messages).toEqual(["Prepared 1 package release(s): alpha-v1.0.1"]);
  });

  it.each(["wrong-v1.0.1", "alpha-vnot-semver"])(
    "rejects malformed semantic-release version output %s",
    async (nextTag) => {
      const root = await createRepository();
      git(root, "tag", "alpha-v1.0.0");
      await commit(root, "feat: add behavior");
      const state = services({ nextTag });
      const automation = createReleaseAutomation({
        root,
        runner: runnerFor(root, state),
        planner: plannerFor(state),
      });

      await expect(automation.prepare()).rejects.toThrow(/unexpected tag|invalid version/);
    },
  );

  it("logs when there are no releasable package changes", async () => {
    const root = await createRepository();
    git(root, "tag", "alpha-v1.0.0");
    const messages: string[] = [];
    const state = services();
    const automation = createReleaseAutomation({
      root,
      runner: runnerFor(root, state),
      log: (message) => messages.push(message),
    });

    await automation.prepare();

    expect(messages).toEqual(["No releasable package changes found."]);
  });

  it("prepares a changelog-only initial release for an untagged package", async () => {
    const root = await createRepository();
    const bodyPath = join(root, "release-body.md");
    const state = services();
    const messages: string[] = [];
    const automation = createReleaseAutomation({
      root,
      runner: runnerFor(root, state),
      planner: plannerFor(state),
      env: { RELEASE_PR_BODY: bodyPath },
      log: (message) => messages.push(message),
    });

    await automation.prepare();

    expect(
      JSON.parse(await readFile(join(root, "packages/alpha/package.json"), "utf8")),
    ).toMatchObject({ version: "1.0.0" });
    expect(await readFile(join(root, "packages/alpha/CHANGELOG.md"), "utf8")).toContain(
      "## generated",
    );
    expect(await readFile(bodyPath, "utf8")).toContain("`@zeldrisho/alpha` → `1.0.0`");
    expect(messages).toEqual(["Prepared 1 package release(s): alpha-v1.0.0"]);
  });

  it("skips an untagged package whose changelog already documents the version", async () => {
    const root = await createRepository();
    await writeFile(
      join(root, "packages/alpha/CHANGELOG.md"),
      "# Changelog\n\n## 1.0.0 (2026-08-05)\n",
    );
    const messages: string[] = [];
    const state = services();
    const automation = createReleaseAutomation({
      root,
      runner: runnerFor(root, state),
      log: (message) => messages.push(message),
    });

    await automation.prepare();

    expect(messages).toEqual(["No releasable package changes found."]);
    expect(state.plannerCalls).toBe(0);
  });

  it("does not bump the manifest when changelog generation fails", async () => {
    const root = await createRepository();
    git(root, "tag", "alpha-v1.0.0");
    await commit(root, "fix: repair alpha");
    const state = services({ failPlan: true });
    const automation = createReleaseAutomation({
      root,
      runner: runnerFor(root, state),
      planner: plannerFor(state),
    });

    await expect(automation.prepare()).rejects.toThrow("Changelog generation failed");
    expect(
      JSON.parse(await readFile(join(root, "packages/alpha/package.json"), "utf8")),
    ).toMatchObject({ version: "1.0.0" });
  });
});

describe("partial-release recovery and service errors", () => {
  it.each([
    ["missing GitHub release", true, true, false, false],
    ["fully released", true, true, true, undefined],
  ] as const)("reports %s", async (_label, tagged, published, released, publish) => {
    const root = await createRepository();
    git(root, "tag", "alpha-v1.0.0");
    const state = services({
      npm: published
        ? { status: 0, stdout: '"1.0.0"', stderr: "" }
        : {
            status: 1,
            stdout: JSON.stringify({ error: { code: "ERR_PNPM_NO_MATCHING_VERSION" } }),
            stderr: "",
          },
      github: released
        ? { status: 0, stdout: "", stderr: "" }
        : { status: 1, stdout: "", stderr: "HTTP 404" },
    });
    let output = "";
    const automation = createReleaseAutomation({
      root,
      runner: runnerFor(root, state),
      env: { GITHUB_REPOSITORY: "owner/repository" },
      stdout: (value) => {
        output += value;
      },
    });

    await automation.status();

    const result = JSON.parse(output) as { include: Array<{ publish: boolean }> };
    if (publish === undefined) expect(result.include).toEqual([]);
    else expect(result.include).toEqual([expect.objectContaining({ publish })]);
  });

  it("plans the release of an untagged package only on a release-merge push", async () => {
    const root = await createRepository();
    git(
      root,
      "commit",
      "--allow-empty",
      "-m",
      "Merge pull request #42 from zeldrisho/semantic-release/release",
    );
    const state = services();
    let output = "";
    const automation = createReleaseAutomation({
      root,
      runner: runnerFor(root, state),
      env: { GITHUB_REPOSITORY: "owner/repository" },
      stdout: (value) => {
        output += value;
      },
    });

    await automation.status();

    const result = JSON.parse(output) as { include: Array<{ publish: boolean }> };
    expect(result.include).toEqual([
      expect.objectContaining({ tag: "alpha-v1.0.0", publish: true }),
    ]);
    expect(state.calls.some((call) => call.command === "gh")).toBe(false);
  });

  it("does not plan an untagged package on a regular feature push", async () => {
    const root = await createRepository();
    const state = services();
    let output = "";
    const automation = createReleaseAutomation({
      root,
      runner: runnerFor(root, state),
      env: { GITHUB_REPOSITORY: "owner/repository" },
      stdout: (value) => {
        output += value;
      },
    });

    await automation.status();

    const result = JSON.parse(output) as { include: Array<{ publish: boolean }> };
    expect(result.include).toEqual([]);
    expect(state.calls.some((call) => call.command === "gh")).toBe(false);
  });

  it("retries an untagged package whose changelog entry already landed on main", async () => {
    const root = await createRepository();
    await writeFile(
      join(root, "packages/alpha/CHANGELOG.md"),
      "# Changelog\n\n## 1.0.0 (2026-08-05)\n",
    );
    const state = services();
    let output = "";
    const automation = createReleaseAutomation({
      root,
      runner: runnerFor(root, state),
      env: { GITHUB_REPOSITORY: "owner/repository" },
      stdout: (value) => {
        output += value;
      },
    });

    await automation.status();

    const result = JSON.parse(output) as { include: Array<{ publish: boolean }> };
    expect(result.include).toEqual([
      expect.objectContaining({ tag: "alpha-v1.0.0", publish: true }),
    ]);
  });

  it.each([
    [
      "malformed npm output",
      { npm: { status: 1, stdout: "not-json", stderr: "registry failed" } },
      "registry failed",
    ],
    [
      "unknown npm error",
      { npm: { status: 1, stdout: '{"error":{"code":"E500","message":"down"}}', stderr: "" } },
      "down",
    ],
    [
      "GitHub API failure",
      {
        npm: { status: 0, stdout: '"1.0.0"', stderr: "" },
        github: { status: 1, stdout: "", stderr: "HTTP 500" },
      },
      "HTTP 500",
    ],
  ] as const)("classifies %s", async (_label, overrides, message) => {
    const root = await createRepository();
    git(root, "tag", "alpha-v1.0.0");
    const state = services(overrides);
    const automation = createReleaseAutomation({
      root,
      runner: runnerFor(root, state),
      env: { GITHUB_REPOSITORY: "owner/repository" },
    });

    await expect(automation.status()).rejects.toThrow(message);
  });
});

describe("GitHub release creation", () => {
  it("rejects invalid package paths", async () => {
    const root = await createRepository();
    const state = services();
    const automation = createReleaseAutomation({ root, runner: runnerFor(root, state) });
    await expect(automation.ensureGithubRelease("packages/missing")).rejects.toThrow(
      "Unknown package path",
    );
  });

  it("resolves HEAD before creating an untagged release", async () => {
    const root = await createRepository();
    await writeFile(
      join(root, "packages/alpha/CHANGELOG.md"),
      "# Changelog\n\n## 1.0.0 (2026-08-05)\n\nInitial release.\n",
    );
    const state = services();
    const automation = createReleaseAutomation({
      root,
      runner: runnerFor(root, state),
      env: { GITHUB_REPOSITORY: "owner/repository" },
    });

    await automation.ensureGithubRelease("packages/alpha");

    const head = git(root, "rev-parse", "HEAD");
    const createCall = state.calls.find(
      (call) => call.command === "gh" && call.args[0] === "release",
    );
    expect(createCall?.args).toContain(head);
    expect(createCall?.args).toContain("--notes-file");
  });

  it.each([
    ["successful", false],
    ["failed", true],
  ] as const)("cleans temporary notes after a %s GitHub release", async (_label, failCreate) => {
    const root = await createRepository();
    await writeFile(
      join(root, "packages/alpha/CHANGELOG.md"),
      "# Changelog\n\n## 1.0.0 (2026-08-05)\n\nInitial release.\n",
    );
    const tempRoot = await mkdtemp(join(tmpdir(), "release-notes-parent-"));
    temporaryDirectories.push(tempRoot);
    const state = services({ failCreate });
    const automation = createReleaseAutomation({
      root,
      runner: runnerFor(root, state),
      env: { GITHUB_REPOSITORY: "owner/repository", GITHUB_SHA: "abc123" },
      temporaryRoot: tempRoot,
    });

    const operation = automation.ensureGithubRelease("packages/alpha");
    if (failCreate) await expect(operation).rejects.toThrow("GitHub create failed");
    else await expect(operation).resolves.toBeUndefined();
    expect(await readdir(tempRoot)).toEqual([]);
  });
});

describe("release CLI", () => {
  function fakeAutomation(): {
    automation: ReleaseAutomation;
    status: ReturnType<typeof vi.fn>;
    prepare: ReturnType<typeof vi.fn>;
    ensureGithubRelease: ReturnType<typeof vi.fn>;
  } {
    const status = vi.fn();
    const prepare = vi.fn();
    const ensureGithubRelease = vi.fn();
    return {
      automation: {
        packageCatalog: vi.fn(),
        componentTags: vi.fn(),
        hasReleasableChanges: vi.fn(),
        assertCurrentVersionIsLatest: vi.fn(),
        status,
        prepare,
        ensureGithubRelease,
      },
      status,
      prepare,
      ensureGithubRelease,
    };
  }

  it.each([
    ["status", undefined],
    ["prepare", undefined],
    ["ensure-github-release", "packages/alpha"],
  ] as const)("dispatches %s", async (command, argument) => {
    const fake = fakeAutomation();
    await runReleaseCli(argument ? [command, argument] : [command], fake.automation);

    if (command === "status") expect(fake.status).toHaveBeenCalledOnce();
    else if (command === "prepare") expect(fake.prepare).toHaveBeenCalledOnce();
    else expect(fake.ensureGithubRelease).toHaveBeenCalledWith("packages/alpha");
  });

  it("rejects a missing package path", async () => {
    await expect(
      runReleaseCli(["ensure-github-release"], fakeAutomation().automation),
    ).rejects.toThrow("A package path is required");
  });

  it("rejects unknown commands with usage", async () => {
    await expect(runReleaseCli(["unknown"], fakeAutomation().automation)).rejects.toThrow("Usage:");
  });
});
