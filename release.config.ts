import type { Options } from "semantic-release";

const pluginPath = "./scripts/semantic-release-plugin.ts";

/** Build the dry-run semantic-release configuration for one independently versioned package. */
export function semanticReleaseOptions(directory: string, packagePath: string): Options {
  return {
    branches: ["main"],
    ci: false,
    dryRun: true,
    tagFormat: `${directory}-v\${version}`,
    plugins: [
      [
        pluginPath,
        {
          packagePath,
          repository: "zeldrisho/pi-packages",
        },
      ],
    ],
  };
}

export default {
  branches: ["main"],
  ci: false,
  dryRun: true,
  plugins: [],
} satisfies Options;
