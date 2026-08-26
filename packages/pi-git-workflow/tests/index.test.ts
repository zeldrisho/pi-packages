// oxlint-disable anti-slop/no-chained-type-assertions, typescript/unbound-method, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns
import { describe, expect, it, vi } from "vite-plus/test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piGitWorkflow, {
  checkMerged,
  checkUpstreamGone,
  detectTargetBranch,
  extractBranchName,
  isGitRepo,
} from "../src/index";

function makePi(
  execImpl: (
    cmd: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>,
): ExtensionAPI {
  return {
    // SAFETY: test mock only implements exec
    exec: (cmd: string, args: string[]) => execImpl(cmd, args),
    on: vi.fn(),
    // SAFETY: test mock coerced to ExtensionAPI; only exec/on are used
  } as unknown as ExtensionAPI;
}

describe("extractBranchName", () => {
  it("extracts -d", () => expect(extractBranchName("git branch -d foo")).toBe("foo"));
  it("extracts -D", () => expect(extractBranchName("git branch -D bar")).toBe("bar"));
  it("extracts --delete", () => expect(extractBranchName("git branch --delete baz")).toBe("baz"));
  it("handles --delete --force", () =>
    expect(extractBranchName("git branch --delete --force qux")).toBe("qux"));
  it("handles --force --delete", () =>
    expect(extractBranchName("git branch --force --delete feature")).toBe("feature"));
  it("returns undefined for non-delete", () =>
    expect(extractBranchName("git status")).toBeUndefined());
});

describe("isGitRepo", () => {
  it("true when git-dir exists", async () => {
    const pi = makePi(async () => ({ code: 0, stdout: ".git", stderr: "", killed: false }));
    expect(await isGitRepo(pi)).toBe(true);
  });
  it("false when not repo", async () => {
    const pi = makePi(async () => ({ code: 128, stdout: "", stderr: "fatal", killed: false }));
    expect(await isGitRepo(pi)).toBe(false);
  });
});

describe("detectTargetBranch", () => {
  it("uses origin/HEAD", async () => {
    const pi = makePi(async (_c, args) => {
      if (args[0] === "symbolic-ref")
        return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: "", killed: false };
    });
    expect(await detectTargetBranch(pi)).toBe("main");
  });
  it("preserves hierarchical branch names", async () => {
    const pi = makePi(async (_c, args) => {
      if (args[0] === "symbolic-ref")
        return { code: 0, stdout: "refs/remotes/origin/release/2026\n", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: "", killed: false };
    });
    expect(await detectTargetBranch(pi)).toBe("release/2026");
  });
  it("falls back to origin/main", async () => {
    const pi = makePi(async (_c, args) => {
      if (args[0] === "symbolic-ref") return { code: 1, stdout: "", stderr: "", killed: false };
      if (args.includes("refs/remotes/origin/main"))
        return { code: 0, stdout: "", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: "", killed: false };
    });
    expect(await detectTargetBranch(pi)).toBe("main");
  });
  it("falls back to origin/master", async () => {
    const pi = makePi(async (_c, args) => {
      if (args[0] === "symbolic-ref") return { code: 1, stdout: "", stderr: "", killed: false };
      if (args.includes("refs/remotes/origin/main"))
        return { code: 1, stdout: "", stderr: "", killed: false };
      if (args.includes("refs/remotes/origin/master"))
        return { code: 0, stdout: "", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: "", killed: false };
    });
    expect(await detectTargetBranch(pi)).toBe("master");
  });
  it("falls back to HEAD", async () => {
    const pi = makePi(async (_c, args) => {
      if (args[0] === "symbolic-ref") return { code: 1, stdout: "", stderr: "", killed: false };
      if (args.includes("refs/remotes/origin/main"))
        return { code: 1, stdout: "", stderr: "", killed: false };
      if (args.includes("refs/remotes/origin/master"))
        return { code: 1, stdout: "", stderr: "", killed: false };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref")
        return { code: 0, stdout: "develop\n", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: "", killed: false };
    });
    expect(await detectTargetBranch(pi)).toBe("develop");
  });
});

describe("checkMerged", () => {
  it("true via branch --merged", async () => {
    const pi = makePi(async (_c, args) => {
      if (args[0] === "branch" && args[1] === "--merged")
        return { code: 0, stdout: "  main\n* feat/x\n  feat/y\n", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: "", killed: false };
    });
    expect(await checkMerged(pi, "feat/x", "main")).toBe(true);
  });
  it("true via merge-base", async () => {
    const pi = makePi(async (_c, args) => {
      if (args[0] === "branch" && args[1] === "--merged")
        return { code: 0, stdout: "  main\n", stderr: "", killed: false };
      if (args[0] === "merge-base") return { code: 0, stdout: "", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: "", killed: false };
    });
    expect(await checkMerged(pi, "feat/x", "main")).toBe(true);
  });
  it("false when not merged", async () => {
    const pi = makePi(async (_c, args) => {
      if (args[0] === "branch" && args[1] === "--merged")
        return { code: 0, stdout: "  main\n", stderr: "", killed: false };
      if (args[0] === "merge-base") return { code: 1, stdout: "", stderr: "", killed: false };
      return { code: 1, stdout: "", stderr: "", killed: false };
    });
    expect(await checkMerged(pi, "feat/x", "main")).toBe(false);
  });
  it("false on branch --merged failure", async () => {
    const pi = makePi(async () => ({ code: 1, stdout: "", stderr: "", killed: false }));
    expect(await checkMerged(pi, "x", "main")).toBe(false);
  });
});

describe("checkUpstreamGone", () => {
  it("true via gone", async () => {
    const pi = makePi(async (_c, args) => {
      if (args[0] === "branch" && args[1] === "-vv")
        return {
          code: 0,
          stdout: "  foo  abc [origin/foo: gone] msg\n",
          stderr: "",
          killed: false,
        };
      return { code: 0, stdout: "", stderr: "", killed: false };
    });
    expect(await checkUpstreamGone(pi, "foo")).toBe(true);
  });
  it("correctly distinguishes branches when one is a prefix of another", async () => {
    const pi = makePi(async (_c, args) => {
      if (args[0] === "branch" && args[1] === "-vv")
        return {
          code: 0,
          stdout: "  foo  abc [origin/foo] msg\n  foobar  def [origin/foobar: gone] other\n",
          stderr: "",
          killed: false,
        };
      if (args[0] === "ls-remote")
        return { code: 0, stdout: "abc\trefs/heads/foo\n", stderr: "", killed: false };
      if (args[0] === "config") return { code: 0, stdout: "origin\n", stderr: "", killed: false };
      return { code: 0, stdout: "", stderr: "", killed: false };
    });
    expect(await checkUpstreamGone(pi, "foo")).toBe(false);
  });
  it("true via ls-remote empty", async () => {
    const pi = makePi(async (_c, args) => {
      if (args[0] === "branch" && args[1] === "-vv")
        return { code: 0, stdout: "  foo  abc [origin/foo] msg\n", stderr: "", killed: false };
      if (args[0] === "ls-remote") return { code: 0, stdout: "", stderr: "", killed: false };
      if (args[0] === "config") return { code: 0, stdout: "origin\n", stderr: "", killed: false };
      return { code: 0, stdout: "", stderr: "", killed: false };
    });
    expect(await checkUpstreamGone(pi, "foo")).toBe(true);
  });
  it("true when no remote and ls empty", async () => {
    const pi = makePi(async (_c, args) => {
      if (args[0] === "branch" && args[1] === "-vv")
        return { code: 0, stdout: "", stderr: "", killed: false };
      if (args[0] === "ls-remote") return { code: 0, stdout: "", stderr: "", killed: false };
      if (args[0] === "config") return { code: 0, stdout: "", stderr: "", killed: false };
      return { code: 0, stdout: "", stderr: "", killed: false };
    });
    expect(await checkUpstreamGone(pi, "foo")).toBe(true);
  });
  it("false when upstream exists", async () => {
    const pi = makePi(async (_c, args) => {
      if (args[0] === "branch" && args[1] === "-vv")
        return { code: 0, stdout: "  foo  abc [origin/foo] msg\n", stderr: "", killed: false };
      if (args[0] === "ls-remote")
        return { code: 0, stdout: "abc\trefs/heads/foo\n", stderr: "", killed: false };
      if (args[0] === "config") return { code: 0, stdout: "origin\n", stderr: "", killed: false };
      return { code: 0, stdout: "", stderr: "", killed: false };
    });
    expect(await checkUpstreamGone(pi, "foo")).toBe(false);
  });
});

describe("piGitWorkflow extension", () => {
  // SAFETY: test captures variably-typed handlers as any; narrowed at call site
  function capture() {
    const handlers = new Map<string, (e: any, ctx: any) => Promise<any>>();
    const pi = {
      exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "", killed: false })),
      on: vi.fn((event: string, h: (e: any, ctx: any) => Promise<any>) => {
        handlers.set(event, h);
      }),
      // SAFETY: test mock only needs exec/on; coerce to ExtensionAPI
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion
    } as unknown as ExtensionAPI;
    piGitWorkflow(pi);
    return { pi, handlers };
  }

  it("before_agent_start injects message when clean", async () => {
    const { handlers, pi } = capture();
    const h = handlers.get("before_agent_start")!;
    vi.mocked(pi.exec).mockImplementation(async (_c: string, args: string[], _opts?: any) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir")
        return { code: 0, stdout: ".git\n", stderr: "", killed: false };
      if (args[0] === "symbolic-ref")
        return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "", killed: false };
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "", killed: false };
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "", killed: false };
      if (args[0] === "branch" && args[1] === "--show-current")
        return { code: 0, stdout: "main\n", stderr: "", killed: false };
      if (args[0] === "branch" && args[1] === "-vv")
        return { code: 0, stdout: "main abc [origin/main] msg\n", stderr: "", killed: false };
      if (args[0] === "rev-parse" && args.includes("@{u}"))
        return { code: 0, stdout: "origin/main\n", stderr: "", killed: false };
      return { code: 0, stdout: "", stderr: "", killed: false };
    });
    const notify = vi.fn();
    // SAFETY: test mock coercion for ExtensionContext/ExtensionAPI
    const ctx: any = { ui: { notify }, hasUI: true };

    // SAFETY: test asserts handler return shape
    const res = (await h({ prompt: "hi", systemPrompt: "", systemPromptOptions: {} }, ctx)) as {
      message: { content: string };
    };
    expect(res.message.content).toContain("fetch --prune: ok");
    expect(res.message.content).toContain("clean");
  });

  it("before_agent_start reports dirty", async () => {
    const { handlers, pi } = capture();
    const h = handlers.get("before_agent_start")!;
    vi.mocked(pi.exec).mockImplementation(async (_c: string, args: string[], _opts?: any) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir")
        return { code: 0, stdout: ".git\n", stderr: "", killed: false };
      if (args[0] === "symbolic-ref")
        return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "", killed: false };
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "", killed: false };
      if (args[0] === "status")
        return { code: 0, stdout: " M foo.ts\n", stderr: "", killed: false };
      if (args[0] === "branch" && args[1] === "--show-current")
        return { code: 0, stdout: "feat/x\n", stderr: "", killed: false };
      if (args[0] === "branch" && args[1] === "-vv")
        return { code: 0, stdout: "feat/x abc [origin/feat/x] msg\n", stderr: "", killed: false };
      if (args[0] === "rev-parse" && args.includes("@{u}"))
        return { code: 0, stdout: "origin/feat/x\n", stderr: "", killed: false };
      return { code: 0, stdout: "", stderr: "", killed: false };
    });
    // SAFETY: test mock coercion for ExtensionContext/ExtensionAPI
    const ctx: any = { ui: { notify: vi.fn() }, hasUI: true };

    // SAFETY: test asserts handler return shape
    const res = (await h({ prompt: "hi", systemPrompt: "", systemPromptOptions: {} }, ctx)) as {
      message: { content: string };
    };
    expect(res.message.content).toContain("DIRTY");
  });

  it("before_agent_start notifies on fetch failure", async () => {
    const { handlers, pi } = capture();
    const h = handlers.get("before_agent_start")!;
    vi.mocked(pi.exec).mockImplementation(async (_c: string, args: string[], _opts?: any) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir")
        return { code: 0, stdout: ".git\n", stderr: "", killed: false };
      if (args[0] === "symbolic-ref")
        return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "", killed: false };
      if (args[0] === "fetch")
        return { code: 1, stdout: "", stderr: "network error", killed: false };
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "", killed: false };
      if (args[0] === "branch" && args[1] === "--show-current")
        return { code: 0, stdout: "main\n", stderr: "", killed: false };
      if (args[0] === "branch" && args[1] === "-vv")
        return { code: 0, stdout: "", stderr: "", killed: false };
      if (args[0] === "rev-parse" && args.includes("@{u}")) throw new Error("no upstream");
      return { code: 0, stdout: "", stderr: "", killed: false };
    });
    const notify = vi.fn();
    // SAFETY: test mock coercion for ExtensionContext/ExtensionAPI
    const ctx: any = { ui: { notify }, hasUI: true };

    // SAFETY: test asserts handler return shape
    const res = (await h({ prompt: "hi", systemPrompt: "", systemPromptOptions: {} }, ctx)) as {
      message: { content: string };
    };
    expect(notify).toHaveBeenCalled();
    expect(res.message.content).toContain("failed");
  });

  it("tool_call blocks -D", async () => {
    const { handlers, pi } = capture();
    const h = handlers.get("tool_call")!;
    vi.mocked(pi.exec).mockResolvedValue({ code: 0, stdout: "", stderr: "", killed: false });
    // SAFETY: test mock coercion for ExtensionContext/ExtensionAPI
    const ctx: any = { hasUI: false, ui: { select: vi.fn() } };

    // SAFETY: test asserts handler return shape
    const res = (await h({ toolName: "bash", input: { command: "git branch -D foo" } }, ctx)) as {
      block: boolean;
    };
    expect(res.block).toBe(true);
  });

  it("tool_call blocks -d when not merged headless", async () => {
    const { handlers, pi } = capture();
    const h = handlers.get("tool_call")!;
    vi.mocked(pi.exec).mockImplementation(async (_c: string, args: string[], _opts?: any) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir")
        return { code: 0, stdout: ".git\n", stderr: "", killed: false };
      if (args[0] === "symbolic-ref")
        return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "", killed: false };
      if (args[0] === "rev-parse" && args[1] === "--verify")
        return { code: 0, stdout: "", stderr: "", killed: false };
      if (args[0] === "branch" && args[1] === "--merged")
        return { code: 0, stdout: "  main\n", stderr: "", killed: false };
      if (args[0] === "merge-base") return { code: 1, stdout: "", stderr: "", killed: false };
      return { code: 0, stdout: "", stderr: "", killed: false };
    });
    // SAFETY: test mock coercion for ExtensionContext/ExtensionAPI
    const ctx: any = { hasUI: false, ui: { select: vi.fn() } };

    // SAFETY: test asserts handler return shape
    const res = (await h(
      { toolName: "bash", input: { command: "git branch -d feat/x" } },
      ctx,
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion
    )) as { block: boolean };
    expect(res.block).toBe(true);
  });

  it("tool_call allows -d when merged and gone", async () => {
    const { handlers, pi } = capture();
    const h = handlers.get("tool_call")!;
    vi.mocked(pi.exec).mockImplementation(async (_c: string, args: string[], _opts?: any) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir")
        return { code: 0, stdout: ".git\n", stderr: "", killed: false };
      if (args[0] === "symbolic-ref")
        return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "", killed: false };
      if (args[0] === "rev-parse" && args[1] === "--verify")
        return { code: 0, stdout: "", stderr: "", killed: false };
      if (args[0] === "branch" && args[1] === "--merged")
        return { code: 0, stdout: "  main\n  feat/x\n", stderr: "", killed: false };
      if (args[0] === "branch" && args[1] === "-vv")
        return {
          code: 0,
          stdout: "  feat/x abc [origin/feat/x: gone] msg\n",
          stderr: "",
          killed: false,
        };
      return { code: 0, stdout: "", stderr: "", killed: false };
    });
    // SAFETY: test mock coercion for ExtensionContext/ExtensionAPI
    const ctx: any = { hasUI: false, ui: { select: vi.fn() } };

    const res = await h({ toolName: "bash", input: { command: "git branch -d feat/x" } }, ctx);
    expect(res).toBeUndefined();
  });

  it("tool_call prompts when not merged interactive", async () => {
    const { handlers, pi } = capture();
    const h = handlers.get("tool_call")!;
    vi.mocked(pi.exec).mockImplementation(async (_c: string, args: string[], _opts?: any) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir")
        return { code: 0, stdout: ".git\n", stderr: "", killed: false };
      if (args[0] === "symbolic-ref")
        return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "", killed: false };
      if (args[0] === "rev-parse" && args[1] === "--verify")
        return { code: 0, stdout: "", stderr: "", killed: false };
      if (args[0] === "branch" && args[1] === "--merged")
        return { code: 0, stdout: "  main\n", stderr: "", killed: false };
      if (args[0] === "merge-base") return { code: 1, stdout: "", stderr: "", killed: false };
      return { code: 0, stdout: "", stderr: "", killed: false };
    });
    const ctx: any = {
      hasUI: true,
      ui: { select: vi.fn(async () => "No, keep branch") },
      // SAFETY: test mock coercion for ExtensionContext/ExtensionAPI
    };

    // SAFETY: test asserts handler return shape
    const res = (await h(
      { toolName: "bash", input: { command: "git branch -d feat/x" } },
      ctx,
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion
    )) as { block: boolean };
    expect(res.block).toBe(true);
  });

  it("passes through non-git bash", async () => {
    const { handlers } = capture();
    const h = handlers.get("tool_call")!;
    // SAFETY: test mock coercion for ExtensionContext/ExtensionAPI
    const ctx: any = { hasUI: false, ui: { select: vi.fn() } };

    const res = await h({ toolName: "bash", input: { command: "echo hi" } }, ctx);
    expect(res).toBeUndefined();
  });

  it("skips when not git repo", async () => {
    const { handlers, pi } = capture();
    const h = handlers.get("tool_call")!;
    const before = handlers.get("before_agent_start")!;
    vi.mocked(pi.exec).mockImplementation(async (_c: string, args: string[], _opts?: any) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir")
        return { code: 128, stdout: "", stderr: "", killed: false };
      return { code: 0, stdout: "", stderr: "", killed: false };
    });
    // SAFETY: test mock coercion for ExtensionContext/ExtensionAPI
    const ctx: any = { ui: { notify: vi.fn() }, hasUI: true };

    const resBefore = await before(
      { prompt: "hi", systemPrompt: "", systemPromptOptions: {} },
      ctx,
    );
    expect(resBefore).toBeUndefined();
    vi.mocked(pi.exec).mockImplementation(async (_c: string, args: string[], _opts?: any) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir")
        return { code: 128, stdout: "", stderr: "", killed: false };
      return { code: 0, stdout: "", stderr: "", killed: false };
    });
    // SAFETY: test mock coercion for ExtensionContext/ExtensionAPI
    const ctx2: any = { ui: { notify: vi.fn() }, hasUI: true };

    // SAFETY: test invokes bash gate with minimal ctx shape
    const res = await h({ toolName: "bash", input: { command: "git branch -d foo" } }, ctx2);
    expect(res).toBeUndefined();
  });
});
