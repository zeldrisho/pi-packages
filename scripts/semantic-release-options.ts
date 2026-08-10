import type { Options } from "semantic-release";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const pluginPath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "semantic-release-plugin.ts",
);

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
