/* v8 ignore file -- executes only inside a worker thread; covered through the parent's integration tests. */
import { parentPort, workerData } from "node:worker_threads";
import { solveAnubisRequest } from "./anubis-solver.js";
/** Solves the challenge supplied as worker data and reports the outcome to the parent. */
function run() {
    const request = workerData;
    try {
        parentPort?.postMessage({ kind: "solved", solution: solveAnubisRequest(request) });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Anubis worker failed.";
        parentPort?.postMessage({ kind: "error", message });
    }
}
run();
