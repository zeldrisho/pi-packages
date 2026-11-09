import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const lockPath = fileURLToPath(
  new URL("../.github/workflows/repo-assist.lock.yml", import.meta.url),
);

const original = readFileSync(lockPath, "utf8");

try {
  execFileSync("gh", ["aw", "compile", "repo-assist", "--no-check-update"], {
    stdio: "inherit",
    env: { ...process.env, GH_AW_DEFAULT_MAX_TURN_CACHE_MISSES: "50" },
  });

  const compiled = readFileSync(lockPath, "utf8");
  const start = compiled.indexOf("\n  push_repo_memory:\n");
  const end = compiled.indexOf("\n  safe_outputs:\n", start);

  if (start < 0 || end < 0) throw new Error("Cannot locate generated repo-memory job");

  const job = compiled.slice(start, end);
  const condition = "needs.agent.result != 'skipped'";

  if (!job.includes("      - safe_outputs\n") || job.split(condition).length !== 2) {
    throw new Error(
      "Unexpected repo-memory job; inspect the compiler output before updating the gate",
    );
  }

  const gated = job.replace(
    condition,
    "needs.agent.result == 'success' && needs.safe_outputs.result == 'success'",
  );

  writeFileSync(lockPath, compiled.slice(0, start) + gated + compiled.slice(end));
} catch (error) {
  writeFileSync(lockPath, original);
  throw error;
}
