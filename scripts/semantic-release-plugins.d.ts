// @semantic-release/commit-analyzer and @semantic-release/release-notes-generator
// ship no TypeScript definitions. Declare only the lifecycle functions used by
// scripts/semantic-release-plugin.ts.
declare module "@semantic-release/commit-analyzer" {
  export function analyzeCommits(
    pluginConfig: { preset?: string },
    context: unknown,
  ): Promise<string | null>;
}

declare module "@semantic-release/release-notes-generator" {
  export function generateNotes(
    pluginConfig: { preset?: string },
    context: unknown,
  ): Promise<string>;
}
