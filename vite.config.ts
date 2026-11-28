import { join } from "node:path";
import cloudflare from "@cloudflare/oxlint-config/vite-plus";
import { defineConfig } from "vite-plus";

// Anchor paths on this file's location so the same config works when vp
// invokes tests from the repository root and from inside packages/<name>/.
const repoRoot = import.meta.dirname;

export default defineConfig({
  test: {
    setupFiles: [join(repoRoot, "tests", "cache-env.setup.ts")],
  },
  run: {
    tasks: {
      ready: {
        command: "vp test",
        dependsOn: ["ready:check", "test:packages"],
        cache: false,
      },
      "ready:check": { command: "vp check", cache: false },
    },
  },
  fmt: {
    ignorePatterns: [
      "dist/**",
      "packages/pi-web-fetch/workers/anubis-solver.js",
      "packages/pi-web-fetch/workers/anubis-worker.js",
      "pnpm-lock.yaml",
      ".github/workflows/*.lock.yml",
      ".agent/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".continue/**",
      ".cursor/**",
      ".gemini/**",
      ".opencode/**",
      ".pi/**",
      ".roo/**",
      ".vite-hooks/**",
      ".windsurf/**",
    ],
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
  },
  lint: {
    extends: [cloudflare],
    env: cloudflare.env,
    ignorePatterns: [
      ...cloudflare.ignorePatterns,
      "dist/**",
      "packages/pi-web-fetch/workers/anubis-solver.js",
      "packages/pi-web-fetch/workers/anubis-worker.js",
      ".agent/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".continue/**",
      ".cursor/**",
      ".gemini/**",
      ".opencode/**",
      ".pi/**",
      ".roo/**",
      ".vite-hooks/**",
      ".windsurf/**",
    ],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "oxc/no-accumulating-spread": "error",
      // Migration baseline: review and re-enable these rules individually.
      "@nkzw/no-instanceof": "off",
      curly: "off",
      "import/consistent-type-specifier-style": "off",
      "preserve-caught-error": "off",
      "typescript/array-type": "off",
      "typescript/consistent-type-imports": "off",
      "typescript/no-misused-promises": "off",
      "typescript/no-non-null-assertion": "off",
      "typescript/no-unsafe-argument": "off",
      "typescript/no-unsafe-assignment": "off",
      "typescript/no-unsafe-call": "off",
      "typescript/no-unsafe-member-access": "off",
      "typescript/no-unsafe-return": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "unicorn/consistent-function-scoping": "off",
      "unicorn/prefer-dom-node-append": "off",
      "unicorn/prefer-string-raw": "off",
      "unicorn/prefer-string-replace-all": "off",
      "unicorn/prefer-top-level-await": "off",
    },
    overrides: [
      {
        // CLI entry points print progress, results, and errors for operators.
        files: [
          "scripts/compatibility.ts",
          "scripts/request-capture.ts",
          "scripts/sync-web-modules.ts",
          "tests/package-smoke-test.ts",
        ],
        rules: { "no-console": "off" },
      },
      {
        files: ["**/*.{ts,tsx,mts,cts}"],
        rules: { "typescript/only-throw-error": "off" },
      },
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  staged: {
    "*": "vp check --fix",
  },
});
