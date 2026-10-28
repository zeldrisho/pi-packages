/* v8 ignore file -- exercised through worker integration tests. */
import { parentPort, workerData } from "node:worker_threads";
import { solveAwsWafWork, type AwsWafWork } from "./aws-waf-solver.ts";

const work: AwsWafWork = workerData;

try {
  parentPort?.postMessage({ kind: "solved", solution: solveAwsWafWork(work) });
} catch (error) {
  parentPort?.postMessage({
    kind: "error",
    message: error instanceof Error ? error.message : "AWS WAF worker failed.",
  });
}
