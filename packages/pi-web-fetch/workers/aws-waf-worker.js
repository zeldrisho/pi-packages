/* v8 ignore file -- exercised through worker integration tests. */
import { parentPort, workerData } from "node:worker_threads";
import { solveAwsWafWork } from "./aws-waf-solver.js";

const work = workerData;

try {
  parentPort?.postMessage({ kind: "solved", solution: solveAwsWafWork(work) });
} catch (error) {
  parentPort?.postMessage({
    kind: "error",
    message: error instanceof Error ? error.message : "AWS WAF worker failed.",
  });
}
