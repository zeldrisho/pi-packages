import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  bashTouchesConfig,
  CONFIG_CHANGE_REASON,
  isProtectedConfigPath,
} from "../../src/config-protection";

let root: string;

let previousDir: string;

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

const originalHome = process.env.HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-gate-path-test-"));
  previousDir = process.cwd();
  process.env.PI_CODING_AGENT_DIR = join(root, ".pi", "agent");
  process.env.HOME = root;
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "gate.json"), "{}", "utf-8");
  process.chdir(root);
});

afterEach(() => {
  process.chdir(previousDir);

  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;

  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
});

describe("config path protection", () => {
  it("recognizes absolute, cwd-relative, home-relative, and symlink paths", () => {
    const config = join(root, ".pi", "agent", "gate.json");
    const alias = join(root, "gate-alias.json");
    symlinkSync(config, alias);

    expect(isProtectedConfigPath(config)).toBe(true);
    expect(isProtectedConfigPath(".pi/agent/gate.json")).toBe(true);
    expect(isProtectedConfigPath("~/.pi/agent/gate.json")).toBe(true);
    expect(isProtectedConfigPath(alias)).toBe(true);
    expect(isProtectedConfigPath(join(root, "notes.txt"))).toBe(false);
    expect(CONFIG_CHANGE_REASON).toBe("pi-gate: gate config change requires approval");
  });

  it("matches config paths but does not match unrelated occurrences of config filenames", () => {
    const config = join(root, ".pi", "agent", "gate.json");

    expect(bashTouchesConfig("echo hi > ~/.pi/agent/gate.json")).toBe(true);
    expect(bashTouchesConfig("cat ~/.pi/agent/gate.json")).toBe(true);
    expect(bashTouchesConfig(`echo hi > ${config}`)).toBe(true);
    expect(bashTouchesConfig("echo hi > $PI_CODING_AGENT_DIR/gate.json")).toBe(true);
    expect(bashTouchesConfig("echo hi > ${PI_CODING_AGENT_DIR}/pi-gate.json")).toBe(true);
    expect(bashTouchesConfig("cd ~/.pi/agent && echo x > gate.json")).toBe(true);

    expect(bashTouchesConfig('rg "gate.json" packages/pi-gate/README.md')).toBe(false);
    expect(bashTouchesConfig("git diff -- packages/pi-gate/README.md")).toBe(false);
    expect(bashTouchesConfig("sed -n 1,5p packages/pi-gate/README.md")).toBe(false);
    expect(bashTouchesConfig("cat pi-gate.json")).toBe(false);
    expect(bashTouchesConfig("echo ok > notes.txt")).toBe(false);
  });
});
