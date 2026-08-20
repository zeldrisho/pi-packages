import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep the web tools' cross-session disk cache out of the developer's real
// cache directory during tests, and isolate it per worker process so cached
// state never leaks between runs or test files (which would otherwise make
// "first fetch is not cached" assertions flaky).
const testCacheRoot = join(tmpdir(), `pi-test-cache-${process.pid}`);
mkdirSync(testCacheRoot, { recursive: true, mode: 0o700 });
process.env.XDG_CACHE_HOME = testCacheRoot;
