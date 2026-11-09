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

  if (!job.includes("      - safe_outputs\n")) {
    throw new Error("Generated repo-memory job is missing its safe_outputs dependency");
  }

  const occurrences = job.split(condition).length - 1;

  if (occurrences !== 1) {
    throw new Error(`Expected one repo-memory agent condition; found ${occurrences}`);
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
