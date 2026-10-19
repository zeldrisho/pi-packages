/* v8 ignore file -- executes only inside a worker thread; covered through the parent's integration tests. */
import { parentPort, workerData } from "node:worker_threads";
import { solveAnubisRequest, type AnubisWorkerRequest } from "./anubis-solver.ts";

/** Solves the challenge supplied as worker data and reports the outcome to the parent. */
function run(): void {
  const request: AnubisWorkerRequest = workerData;

  try {
    parentPort?.postMessage({ kind: "solved", solution: solveAnubisRequest(request) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Anubis worker failed.";

    parentPort?.postMessage({ kind: "error", message });
  }
}

run();
