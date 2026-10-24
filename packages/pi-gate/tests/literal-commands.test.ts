import { describe, expect, it } from "vite-plus/test";
import { literalCommands } from "../src/literal-commands";

describe("literal command recognition", () => {
  it("recognizes literal words, concatenated quotes, and escapes", () => {
    expect(literalCommands(`su'do' tr\\ue`)).toEqual([{ text: "sudo true", literalOutput: false }]);
    expect(literalCommands(`echo 'sudo true' "safe text" escaped\\ word`)).toEqual([
      { text: "echo sudo true safe text escaped word", literalOutput: true },
    ]);
    expect(literalCommands('printf "\\q\\\"\\\\\\$\\`"')).toEqual([
      { text: 'printf \\q"\\$`', literalOutput: true },
    ]);
    expect(literalCommands("echo ''")).toEqual([{ text: "echo ", literalOutput: true }]);
  });

  it("separates simple command lists and skips comments", () => {
    expect(
      literalCommands("# comment\necho sudo && true || printf ok; git status & pwd\n"),
    ).toEqual([
      { text: "echo sudo", literalOutput: true },
      { text: "true", literalOutput: false },
      { text: "printf ok", literalOutput: true },
      { text: "git status", literalOutput: false },
      { text: "pwd", literalOutput: false },
    ]);
    expect(literalCommands("echo sudo # comment")).toEqual([
      { text: "echo sudo", literalOutput: true },
    ]);
    expect(literalCommands("echo abc#def")).toEqual([
      { text: "echo abc#def", literalOutput: true },
    ]);
    expect(literalCommands(" \t\n# comment")).toEqual([]);
  });

  it.each([
    "echo sudo | sh",
    "echo sudo |& sh",
    "echo $VALUE",
    'echo "$VALUE"',
    'echo "`sudo`"',
    "echo `sudo`",
    "(sudo)",
    "{ sudo; }",
    "echo sudo > script",
    "cat < script",
    "echo *",
    "echo ?",
    "echo [a]",
    "echo ~",
    "! sudo",
    "echo 'unfinished",
    'echo "unfinished',
    "echo trailing\\",
    "echo continued\\\nline",
    "echo continued\\\rline",
    "bash -c 'sudo; true'",
    "bash -c 'sudo true'",
    "bash -c 'sudo' ; echo $VALUE",
    "echo ".repeat(20_000),
  ])("falls back instead of guessing about %s", (command) => {
    expect(literalCommands(command)).toBeUndefined();
  });
});
