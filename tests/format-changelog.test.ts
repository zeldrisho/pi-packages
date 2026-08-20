import { describe, it, expect } from "vite-plus/test";
import { formatChangelog } from "../scripts/format-changelog.ts";

const REPO_URL = "https://github.com/zeldrisho/pi-packages";

describe("formatChangelog", () => {
  it("rewrites legacy version headings to Keep a Changelog 2.0.0", () => {
    const input =
      "# Changelog\n\n" +
      "## [1.0.0](https://github.com/zeldrisho/pi-packages/compare/alpha-v0.9.0...alpha-v1.0.0) (2026-08-01)\n\n" +
      "### Added\n\n- First\n\n" +
      "## [1.0.1](https://github.com/zeldrisho/pi-packages/compare/alpha-v1.0.0...alpha-v1.0.1) (2026-08-12)\n\n" +
      "### Bug fixes\n\n- Fix a thing\n";
    const output = formatChangelog(input, { repoUrl: REPO_URL, packageDirectory: "alpha" });
    expect(output).toContain("## [1.0.1] - 2026-08-12");
    expect(output).toContain("## [1.0.0] - 2026-08-01");
    expect(output).not.toContain("## [1.0.1](");
    expect(output).toContain(
      "[1.0.1]: https://github.com/zeldrisho/pi-packages/compare/alpha-v1.0.0...alpha-v1.0.1",
    );
    // 1.0.0 is the oldest documented version, so it links to its tag.
    expect(output).toContain(
      "[1.0.0]: https://github.com/zeldrisho/pi-packages/releases/tag/alpha-v1.0.0",
    );
  });

  it("folds non-standard section titles into the six standard types", () => {
    const input =
      "# Changelog\n\n" +
      "## [1.0.0] - 2026-08-01\n\n" +
      "### Bug fixes\n\n- Fix\n\n### Maintenance\n\n- Upgrade deps\n\n### Documentation\n\n- Docs\n";
    const output = formatChangelog(input, { repoUrl: REPO_URL, packageDirectory: "alpha" });
    expect(output).toContain("### Fixed");
    expect(output).toContain("### Changed");
    expect(output).not.toContain("### Bug fixes");
    expect(output).not.toContain("### Maintenance");
    expect(output).not.toContain("### Documentation");
    // Standard type order: Added, Changed, Deprecated, Removed, Fixed, Security.
    expect(output.indexOf("### Changed")).toBeLessThan(output.indexOf("### Fixed"));
  });

  it("adds the standard intro and an Unreleased section", () => {
    const input = "# Changelog\n\n## [1.0.0] - 2026-08-01\n\n### Added\n\n- New\n";
    const output = formatChangelog(input, { repoUrl: REPO_URL, packageDirectory: "alpha" });
    expect(output.startsWith("# Changelog\n")).toBe(true);
    expect(output).toContain("The format is based on [Keep a Changelog]");
    expect(output).toContain("## [Unreleased]");
    expect(output).toContain(
      "[Unreleased]: https://github.com/zeldrisho/pi-packages/compare/alpha-v1.0.0...HEAD",
    );
    expect(output).toContain(
      "[1.0.0]: https://github.com/zeldrisho/pi-packages/releases/tag/alpha-v1.0.0",
    );
  });

  it("keeps bullets contiguous and preserves their text", () => {
    const input =
      "# Changelog\n\n## [1.0.0] - 2026-08-01\n\n### Fixed\n\n- One\n\n- Two\n\n- Three\n";
    const output = formatChangelog(input, { repoUrl: REPO_URL, packageDirectory: "alpha" });
    expect(output).toContain("- One\n- Two\n- Three");
  });
});
