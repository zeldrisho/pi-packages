import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";

const source = await readFile(
  new URL("../.github/workflows/repo-assist.md", import.meta.url),
  "utf8",
);

const compiled = await readFile(
  new URL("../.github/workflows/repo-assist.lock.yml", import.meta.url),
  "utf8",
);

describe("repo-assist workflow contracts", () => {
  it("serializes all runs sharing repository memory without cancelling pending work", () => {
    expect(compiled).toContain(
      "concurrency:\n  cancel-in-progress: false\n  group: repo-assist-memory\n  queue: max",
    );
  });

  it("only publishes memory after the agent and safe outputs succeed", () => {
    const job = compiled.split("\n  push_repo_memory:\n")[1]?.split("\n  safe_outputs:\n")[0];
    expect(job).toContain("      - safe_outputs\n");
    expect(job).toContain(
      "needs.agent.result == 'success' && needs.safe_outputs.result == 'success'",
    );
    expect(job).toContain("(!cancelled())");
  });

  it("fails safe-output processing on skipped or incomplete results before publishing memory", () => {
    const job = compiled.split("\n  safe_outputs:\n")[1];
    expect(job).toContain("- name: Require complete safe-output application");

    for (const output of ["items_skipped", "items_failed", "items_deferred", "items_cancelled"]) {
      expect(job).toContain(`steps.process_safe_outputs.outputs.${output}`);
    }

    expect(job).toContain('"$PROCESS_OUTCOME" != success');
    expect(job).toContain('"$SKIPPED" != 0');
    expect(job).toContain('"$FAILED" != 0');
    expect(job).toContain('"$DEFERRED" != 0');
    expect(job).toContain('"$CANCELLED" != 0');
    expect(job).toContain("Memory will not be published");
  });

  it("requires review on creation and refuses protected-file branch pushes", () => {
    for (const [output, policy] of [
      ["create-pull-request", "request-review"],
      ["push-to-pull-request-branch", "blocked"],
    ]) {
      const section = source.split(`  ${output}:\n`)[1]?.split(/\n  [a-z][a-z-]+:\n/u)[0];
      expect(section).toContain(`policy: ${policy}`);
    }

    const config = compiled.match(/GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG: "(.*)"/u)?.[1];
    expect(config).toBeDefined();
    const parsed = JSON.parse(JSON.parse(`"${config}"`));
    expect(parsed.create_pull_request.protected_files_policy).toBe("request-review");
    expect(parsed.push_to_pull_request_branch.protected_files_policy).toBe("blocked");
  });
});
