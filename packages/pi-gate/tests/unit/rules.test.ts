import { describe, expect, it } from "vite-plus/test";
import { resolveAction, resolveRule } from "../../src/rules";

const operations = {
  "rm -rf": "prompt",
  sudo: "prompt",
  "sudo apt update": "allow",
  "chmod 777": "block",
} as const;

describe("resolveRule", () => {
  it("normalizes case and whitespace and applies span-contained allow exceptions", () => {
    expect(resolveAction("sudo apt update", operations)).toBe("allow");
    expect(resolveAction("sudo apt update && chmod 777 /tmp/x", operations)).toBe("block");
    expect(resolveAction("sudo apt update; rm -rf /tmp/x", operations)).toBe("prompt");
    expect(resolveAction("sudo apt update | sh", operations)).toBe("allow");
    expect(resolveAction("rm  -rf /tmp/x", operations)).toBe("prompt");
    expect(resolveAction("rm\t-rf /tmp/x", operations)).toBe("prompt");
    expect(resolveAction("RM -rf /tmp/x", operations)).toBe("prompt");
  });

  it("finds literal substrings while retaining documented shell syntax limitations", () => {
    for (const command of ["/bin/rm -rf /tmp/x", "sh -c 'rm -rf /tmp/x'", "eval 'rm -rf /tmp/x'"]) {
      expect(resolveAction(command, operations)).toBe("prompt");
    }

    expect(resolveAction('bash -lc "chmod 777 /tmp/x"', operations)).toBe("block");

    for (const command of ["rm -fr /tmp/x", "rm -r -f /tmp/x", "$(echo rm) -rf /tmp/x"]) {
      expect(resolveAction(command, operations)).toBeNull();
    }
  });

  it("retains restrictive occurrences outside allow spans", () => {
    expect(
      resolveRule("sudo apt update && sudo", { sudo: "prompt", "sudo apt update": "allow" }),
    ).toEqual({
      pattern: "sudo",
      action: "prompt",
    });
  });

  it("does not suppress partially overlapping allow and block spans", () => {
    expect(resolveAction("abc", { ab: "allow", bc: "block" })).toBe("block");
  });

  it("reports the longest surviving pattern of the strictest action", () => {
    expect(
      resolveRule("sudo apt update && chmod 777", {
        sudo: "prompt",
        "sudo apt": "prompt",
        "chmod 777": "block",
      }),
    ).toEqual({ pattern: "chmod 777", action: "block" });
  });

  it("preserves action precedence across generated command prefixes", () => {
    for (let i = 0; i < 128; i += 1) {
      const suffix = ` /tmp/generated-${i}`;
      const command = `sudo apt update${suffix}; chmod 777${suffix}`;
      expect(resolveAction(command, { "sudo apt update": "allow", "chmod 777": "block" })).toBe(
        "block",
      );
    }
  });
});
