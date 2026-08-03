import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vite-plus/test";

const temporaryDirectories: string[] = [];

async function releaseNoteDirectories(): Promise<Set<string>> {
  return new Set(
    (await readdir(tmpdir())).filter((entry) => entry.startsWith("git-cliff-release-")),
  );
}

async function runEnsureGithubRelease(failCreate: boolean): Promise<number | null> {
  const binDirectory = await mkdtemp(join(tmpdir(), "release-test-bin-"));
  temporaryDirectories.push(binDirectory);
  const gh = join(binDirectory, "gh");
  const gitCliff = join(binDirectory, "git-cliff");
  await writeFile(
    gh,
    `#!/bin/sh
if [ "$1" = "api" ]; then echo 'HTTP 404' >&2; exit 1; fi
if [ "${failCreate ? "yes" : "no"}" = "yes" ]; then exit 2; fi
exit 0
`,
  );
  await writeFile(gitCliff, "#!/bin/sh\nprintf 'Release notes'\n");
  await Promise.all([chmod(gh, 0o755), chmod(gitCliff, 0o755)]);

  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "release.ts"), "ensure-github-release", "packages/pi-web-fetch"],
    {
      cwd: join(import.meta.dirname, ".."),
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "zeldrisho/pi-packages",
        PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    },
  );
  return result.status;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("release note temporary directory cleanup", () => {
  it.each([
    ["successful", false, 0],
    ["failed", true, 1],
  ] as const)(
    "cleans notes after a %s GitHub release",
    async (_label, failCreate, expectedStatus) => {
      const before = await releaseNoteDirectories();
      const status = await runEnsureGithubRelease(failCreate);
      const after = await releaseNoteDirectories();

      expect(status === 0 ? 0 : 1).toBe(expectedStatus);
      expect([...after].filter((directory) => !before.has(directory))).toEqual([]);
    },
  );
});
