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

  const gatedCompiled = compiled.slice(0, start) + gated + compiled.slice(end);
  const upload = "      - name: Upload Safe Outputs Items\n";

  if (gatedCompiled.split(upload).length !== 2) {
    throw new Error("Expected exactly one safe-output artifact upload step");
  }

  const outcomeGate = `      - name: Require complete safe-output application
        if: always()
        env:
          PROCESS_OUTCOME: \${{ steps.process_safe_outputs.outcome }}
          SKIPPED: \${{ steps.process_safe_outputs.outputs.items_skipped }}
          FAILED: \${{ steps.process_safe_outputs.outputs.items_failed }}
          DEFERRED: \${{ steps.process_safe_outputs.outputs.items_deferred }}
          CANCELLED: \${{ steps.process_safe_outputs.outputs.items_cancelled }}
        run: |
          if [ "$PROCESS_OUTCOME" != success ] || [ "$SKIPPED" != 0 ] || [ "$FAILED" != 0 ] || [ "$DEFERRED" != 0 ] || [ "$CANCELLED" != 0 ]; then
            echo "::error::Safe outputs were not fully applied (skipped: $SKIPPED, failed: $FAILED, deferred: $DEFERRED, cancelled: $CANCELLED). Memory will not be published. Inspect the safe-output summary and artifacts."
            exit 1
          fi
`;

  writeFileSync(lockPath, gatedCompiled.replace(upload, outcomeGate + upload));
} catch (error) {
  writeFileSync(lockPath, original);
  throw error;
}
