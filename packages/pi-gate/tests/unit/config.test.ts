import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  ensureConfig,
  formatCommandForDisplay,
  highlightRuleForDisplay,
  loadConfig,
  parseConfig,
  resolveAction,
  resolveRule,
  CONFIG_SCHEMA_URL,
  DEFAULT_PROMPT_TIMEOUT_MS,
  MAX_DISPLAY_COMMAND_CHARACTERS,
  MAX_DISPLAY_COMMAND_LINES,
  MAX_RULE_COUNT,
  MAX_RULE_PATTERN_LENGTH,
  type Action,
} from "../../src/index";

let workDir: string;

const originalEnv = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pi-gate-config-test-"));
  process.env.PI_CODING_AGENT_DIR = workDir;
});

afterEach(() => {
  if (originalEnv !== undefined) process.env.PI_CODING_AGENT_DIR = originalEnv;
  else delete process.env.PI_CODING_AGENT_DIR;
  rmSync(workDir, { recursive: true, force: true });
});

function setConfig(content: string | null): void {
  const path = join(workDir, "gate.json");

  if (content === null) {
    rmSync(path, { force: true });

    return;
  }

  writeFileSync(path, content, "utf-8");
}

describe("parseConfig", () => {
  const emptyConfig = { operations: {}, promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS };

  it("returns an empty configuration for invalid JSON", () => {
    expect(parseConfig("{not valid")).toEqual(emptyConfig);
  });

  it("returns an empty configuration for a non-object root", () => {
    expect(parseConfig('"a string"')).toEqual(emptyConfig);
    expect(parseConfig("42")).toEqual(emptyConfig);
    expect(parseConfig("null")).toEqual(emptyConfig);
    expect(parseConfig("[1, 2, 3]")).toEqual(emptyConfig);
  });

  it("returns an empty configuration when operations is missing", () => {
    expect(parseConfig("{}")).toEqual(emptyConfig);
    expect(parseConfig('{"other": []}')).toEqual(emptyConfig);
  });

  it("returns an empty configuration when operations is not an object", () => {
    expect(parseConfig('{"operations": []}')).toEqual(emptyConfig);
    expect(parseConfig('{"operations": "nope"}')).toEqual(emptyConfig);
  });

  it("accepts a positive prompt timeout up to one day", () => {
    expect(parseConfig('{"promptTimeoutMs":15000,"operations":{}}').promptTimeoutMs).toBe(15000);
    expect(parseConfig('{"promptTimeoutMs":86400000,"operations":{}}').promptTimeoutMs).toBe(
      86_400_000,
    );
  });

  it("uses the default prompt timeout for invalid values", () => {
    for (const value of [0, -1, 1.5, 86_400_001, "1000", null]) {
      const config = parseConfig(JSON.stringify({ promptTimeoutMs: value, operations: {} }));
      expect(config.promptTimeoutMs).toBe(DEFAULT_PROMPT_TIMEOUT_MS);
    }
  });

  it("preserves valid rules", () => {
    const result = parseConfig(
      JSON.stringify({
        operations: {
          "rm -rf": "prompt",
          sudo: "block",
          "git push": "allow",
        },
      }),
    );

    expect(result.operations).toEqual({
      "rm -rf": "prompt",
      sudo: "block",
      "git push": "allow",
    });
  });

  it("skips rules with invalid actions", () => {
    const result = parseConfig(
      JSON.stringify({
        operations: {
          "rm -rf": "prompt",
          "bad-action": "maybe",
          "not-a-string": 42,
        },
      }),
    );

    expect(result.operations).toEqual({ "rm -rf": "prompt" });
  });

  it("fails closed for generated malformed operation values while retaining valid rules", () => {
    const invalidValues: unknown[] = [null, false, 0, [], {}, "", "ALLOW", "execute", "block "];

    for (const invalid of invalidValues) {
      const config = parseConfig(
        JSON.stringify({ operations: { safe: "prompt", generated: invalid } }),
      );

      expect(config.operations).toEqual({ safe: "prompt" });
      expect(
        Object.values(config.operations).every((action) =>
          ["prompt", "block", "allow"].includes(action),
        ),
      ).toBe(true);
    }
  });

  it("skips empty and excessively long patterns", () => {
    const tooLong = "x".repeat(MAX_RULE_PATTERN_LENGTH + 1);

    const result = parseConfig(
      JSON.stringify({ operations: { "": "block", valid: "prompt", [tooLong]: "allow" } }),
    );

    expect(result.operations).toEqual({ valid: "prompt" });
  });

  it("caps the number of accepted rules", () => {
    const operations = Object.fromEntries(
      Array.from({ length: MAX_RULE_COUNT + 5 }, (_, index) => [`rule-${index}`, "block"]),
    );

    expect(Object.keys(parseConfig(JSON.stringify({ operations })).operations)).toHaveLength(
      MAX_RULE_COUNT,
    );
  });
});

describe("formatCommandForDisplay", () => {
  it("normalizes line endings and visibly escapes terminal and bidi controls", () => {
    expect(formatCommandForDisplay("one\r\ntwo\r\x1b[31m\u202Etxt\0")).toBe(
      "one\ntwo\n\\u{001b}[31m\\u{202e}txt\\u{0000}",
    );
  });

  it("bounds displayed command characters without changing the prefix", () => {
    const result = formatCommandForDisplay("x".repeat(MAX_DISPLAY_COMMAND_CHARACTERS + 101));
    expect(result).toContain("x".repeat(MAX_DISPLAY_COMMAND_CHARACTERS));
    expect(result).toContain("[101 more characters hidden]");
  });

  it("bounds displayed command lines", () => {
    const result = formatCommandForDisplay(
      Array.from({ length: MAX_DISPLAY_COMMAND_LINES + 1 }, (_, index) => `line-${index}`).join(
        "\n",
      ),
    );

    expect(result.split("\n")).toHaveLength(MAX_DISPLAY_COMMAND_LINES + 1);
    expect(result).toMatch(/\[\d+ more characters hidden\]/u);
    expect(result).not.toContain(`line-${MAX_DISPLAY_COMMAND_LINES}`);
  });
});

describe("highlightRuleForDisplay", () => {
  it("wraps every visible occurrence of the matched rule", () => {
    expect(highlightRuleForDisplay("sudo echo sudo", "sudo")).toBe("»sudo« echo »sudo«");
  });

  it("highlights terminal-safe text without restoring control characters", () => {
    expect(highlightRuleForDisplay("dangerous\x1b[31m", "dangerous")).toBe(
      "»dangerous«\\u{001b}[31m",
    );
  });

  it("distinguishes a raw control-character match from its literal escaped representation", () => {
    expect(highlightRuleForDisplay("actual \x1b literal \\u{001b}", "\x1b")).toBe(
      "actual »\\u{001b}« literal \\u{001b}",
    );
  });

  it("does not highlight words in the generated truncation notice", () => {
    const result = highlightRuleForDisplay(
      `command ${"x".repeat(MAX_DISPLAY_COMMAND_CHARACTERS)}`,
      "command",
    );

    expect(result).toContain("»command«");
    expect(result).toMatch(/\[\d+ more characters hidden\]/u);
    expect(result).not.toContain("command« display truncated]");
  });
});

describe("loadConfig", () => {
  it("returns an empty configuration when the file is missing", () => {
    expect(loadConfig()).toEqual({
      operations: {},
      promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
    });
  });

  it("returns the parsed configuration when the file is present", () => {
    setConfig(JSON.stringify({ operations: { sudo: "block" }, promptTimeoutMs: 5000 }));
    expect(loadConfig()).toEqual({ operations: { sudo: "block" }, promptTimeoutMs: 5000 });
  });

  it("returns an empty configuration when the file is malformed", () => {
    setConfig("{ not valid");
    expect(loadConfig()).toEqual({
      operations: {},
      promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
    });
  });
});

describe("resolveRule", () => {
  it("returns the matching pattern and action", () => {
    expect(resolveRule("sudo apt update", { sudo: "block" })).toEqual({
      pattern: "sudo",
      action: "block",
    });
  });

  it("allows only when the allow span contains the restrictive match", () => {
    expect(
      resolveRule("rm -rf /", { rm: "block", "rm -rf": "prompt", "rm -rf /": "allow" }),
    ).toEqual({ pattern: "rm -rf /", action: "allow" });
    expect(resolveRule("rm -rf / && rm", { rm: "block", "rm -rf /": "allow" })).toEqual({
      pattern: "rm",
      action: "block",
    });
  });

  it("returns null when no rule matches", () => {
    expect(resolveRule("ls -la", { sudo: "block" })).toBeNull();
  });
});

describe("resolveAction", () => {
  it("keeps starter rules from prompting on common safe commands", () => {
    const starterRules = {
      "rm -rf": "prompt",
      sudo: "prompt",
      "sudo apt update": "allow",
      "chmod 777": "block",
      "corepack enable": "block",
    } as const;

    for (const command of ["ls -la", "pwd", "echo hello", "git status", "cat README.md"]) {
      expect(resolveAction(command, starterRules), command).toBeNull();
    }

    expect(resolveAction("sudo apt update", starterRules)).toBe("allow");
  });
  it("returns null when no rule matches", () => {
    expect(resolveAction("ls -la", { sudo: "block" })).toBeNull();
  });

  it("returns the action of a single matching rule", () => {
    expect(resolveAction("sudo apt update", { sudo: "block" })).toBe<Action>("block");
    expect(resolveAction("rm -rf node_modules", { "rm -rf": "prompt" })).toBe<Action>("prompt");
  });

  it("uses block precedence over prompt and allow", () => {
    const action = resolveAction("rm -rf / && sudo && chmod 777", {
      rm: "block",
      "rm -rf": "prompt",
      "rm -rf /": "allow",
      sudo: "prompt",
      "chmod 777": "block",
    });

    expect(action).toBe<Action>("block");
  });

  it("returns null for an empty rule set", () => {
    expect(resolveAction("anything", {})).toBeNull();
  });
});

describe("ensureConfig", () => {
  it("writes the default configuration on first run", () => {
    ensureConfig();
    const path = join(workDir, "gate.json");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(workDir, "pi-gate.json"))).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      $schema: CONFIG_SCHEMA_URL,
      promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
      operations: {
        "rm -rf": "prompt",
        sudo: "prompt",
        "sudo apt update": "allow",
        "chmod 777": "block",
        "corepack enable": "block",
      },
    });
  });

  it("does not overwrite an existing configuration", () => {
    const path = join(workDir, "gate.json");
    writeFileSync(path, '{"operations":{"x":"block"}}', "utf-8");
    ensureConfig();
    expect(readFileSync(path, "utf-8")).toBe('{"operations":{"x":"block"}}');
  });
});
