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
  CONFIG_SCHEMA_URL,
  DEFAULT_PROMPT_TIMEOUT_MS,
  MAX_DISPLAY_COMMAND_CHARACTERS,
  MAX_DISPLAY_COMMAND_LINES,
  MAX_RULE_COUNT,
  MAX_RULE_PATTERN_LENGTH,
} from "../src/index";

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

  writeFileSync(path, content, "utf8");
}

describe("parseConfig", () => {
  const emptyConfig = { operations: {}, promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS };

  it("returns an empty configuration when JSON or its operations object is invalid", () => {
    const invalidConfigs = [
      "{not valid",
      '"a string"',
      "42",
      "null",
      "[1, 2, 3]",
      "{}",
      '{"other": []}',
      '{"operations": []}',
      '{"operations": "nope"}',
    ];

    for (const input of invalidConfigs) {
      expect.soft(parseConfig(input), input).toEqual(emptyConfig);
    }
  });

  it("accepts positive prompt timeouts up to one day and defaults out-of-range values", () => {
    expect(parseConfig('{"promptTimeoutMs":15000,"operations":{}}').promptTimeoutMs).toBe(15000);
    expect(parseConfig('{"promptTimeoutMs":86400000,"operations":{}}').promptTimeoutMs).toBe(
      86_400_000,
    );

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

  it("fails closed for generated malformed operation values while retaining valid rules", () => {
    const invalidValues: unknown[] = [null, false, 0, 42, [], {}, "", "maybe", "ALLOW", "block "];

    for (const invalid of invalidValues) {
      const config = parseConfig(
        JSON.stringify({ operations: { safe: "prompt", generated: invalid } }),
      );

      expect.soft(config.operations, JSON.stringify(invalid)).toEqual({ safe: "prompt" });
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
  it("highlights each visible match without restoring terminal control characters", () => {
    expect(highlightRuleForDisplay("sudo echo sudo\x1b[31m", "sudo")).toBe(
      "»sudo« echo »sudo«\\u{001b}[31m",
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
  it("loads the current file and returns defaults if it is missing or malformed", () => {
    const emptyConfig = { operations: {}, promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS };

    expect.soft(loadConfig(), "missing file").toEqual(emptyConfig);
    setConfig("{ not valid");
    expect.soft(loadConfig(), "malformed file").toEqual(emptyConfig);
    setConfig(JSON.stringify({ operations: { sudo: "block" }, promptTimeoutMs: 5000 }));
    expect(loadConfig()).toEqual({ operations: { sudo: "block" }, promptTimeoutMs: 5000 });
  });
});

describe("ensureConfig", () => {
  it("writes starter rules on first run without gating common safe commands", () => {
    ensureConfig();
    const path = join(workDir, "gate.json");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(workDir, "pi-gate.json"))).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
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

    const { operations } = loadConfig();

    for (const command of ["ls -la", "pwd", "echo hello", "git status", "cat README.md"]) {
      expect.soft(resolveAction(command, operations), command).toBeNull();
    }

    expect(resolveAction("sudo apt update", operations)).toBe("allow");
  });

  it("does not overwrite an existing configuration", () => {
    const path = join(workDir, "gate.json");
    writeFileSync(path, '{"operations":{"x":"block"}}', "utf8");
    ensureConfig();
    expect(readFileSync(path, "utf8")).toBe('{"operations":{"x":"block"}}');
  });
});
