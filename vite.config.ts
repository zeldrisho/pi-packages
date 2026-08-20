import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: [["text", { skipFull: false }]],
      include: ["packages/*/src/**/*.ts"],
      thresholds: {
        perFile: true,
        lines: 80,
        functions: 75,
        statements: 75,
        branches: 60,
      },
    },
  },
  fmt: {
    ignorePatterns: ["coverage/**", "dist/**", "pnpm-lock.yaml"],
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
  },
  lint: {
    ignorePatterns: ["coverage/**", "dist/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  staged: {
    "*": "vp check --fix",
  },
});
