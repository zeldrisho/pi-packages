import { describe, expect, it } from "vite-plus/test";
import { resolveAction, resolveRule } from "../src/rules";

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

  it("does not suppress partially overlapping whole-word allow and block spans", () => {
    expect(resolveAction("sudo apt update", { "sudo apt": "allow", "apt update": "block" })).toBe(
      "block",
    );
    expect(resolveAction("$(abc)", { ab: "allow", bc: "block" })).toBe("block");
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

  it.each([
    "echo sudo",
    "echo 'sudo apt update'",
    'echo "sudo"',
    "printf '%s\\n' sudo",
    "printf '%s' 'git checkout main'",
    "git checkout-index --help",
    "git switcheroo",
    "gh pr create-example",
    "git status # sudo",
    "# sudo\ngit status",
    "echo sudo && git status",
    "echo sudo || git status",
    "echo sudo & git status",
    "echo sudo\ngit status",
    "echo '$(sudo)'",
  ])("ignores literal output, comments, or partial words: %s", (command) => {
    expect(
      resolveAction(command, {
        sudo: "prompt",
        "git checkout": "prompt",
        "git switch": "prompt",
        "gh pr create": "prompt",
      }),
    ).toBeNull();
  });

  it.each([
    "sudo true",
    "/usr/bin/sudo true",
    "'sudo' true",
    "su'do' true",
    "echo sudo; sudo true",
    "echo sudo && sudo true",
    "echo sudo || sudo true",
    "echo sudo & sudo true",
    "echo sudo\nsudo true",
    "echo sudo # comment\nsudo true",
    "echo $(sudo true)",
    "echo `sudo true`",
    "echo sudo | sh",
    "printf sudo | xargs",
    "echo sudo |& bash",
    "echo sudo > /tmp/script; bash /tmp/script",
    "bash -c 'sudo; true'",
    "bash -c 'sudo'",
    "python -c \"import os; os.system('sudo true')\"",
    "VAR=value sudo true",
    "env sudo true",
    "(sudo true)",
    "echo sudo\\\n",
    "echo 'sudo",
    `echo ${"x".repeat(65_536)} sudo`,
  ])("keeps actual calls and uncertain shell constructs gated: %s", (command) => {
    expect(resolveAction(command, { sudo: "prompt" })).toBe("prompt");
  });

  it("preserves restrictive combined-flag and numeric-mode coverage", () => {
    expect(resolveAction("rm -rfv /tmp/example", operations)).toBe("prompt");
    expect(resolveAction("chmod 7777 /tmp/example", operations)).toBe("block");
    expect(resolveAction("rm -rfv /tmp/example", { rm: "block", "rm -rf": "allow" })).toBe("block");
    expect(resolveAction("chmod 7777", { chmod: "block", "chmod 777": "allow" })).toBe("block");
  });

  it("still honors explicit output-command rules", () => {
    expect(resolveAction("echo sudo", { "echo sudo": "block" })).toBe("block");
    expect(resolveAction("printf sudo", { printf: "prompt" })).toBe("prompt");
    expect(resolveAction("echo 'sudo'", { "echo 'sudo'": "block" })).toBe("block");
  });

  it("does not let an allow in a later command suppress an earlier restriction", () => {
    expect(resolveAction("sudo true; sudo apt update", operations)).toBe("prompt");
    expect(resolveAction("sudo true; echo sudo", { sudo: "block", "echo sudo": "allow" })).toBe(
      "block",
    );
  });

  it("keeps conservative matching for other programs' arguments", () => {
    expect(resolveAction("some-interpreter sudo", { sudo: "prompt" })).toBe("prompt");
    expect(resolveAction("grep sudo file", { sudo: "prompt" })).toBe("prompt");
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
