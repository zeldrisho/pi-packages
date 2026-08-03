import { describe, expect, it, vi } from "vite-plus/test";
import { awaitWithAbort } from "../src/abort";

describe("awaitWithAbort", () => {
  it("rejects an already-aborted signal without attaching a listener", async () => {
    const controller = new AbortController();
    controller.abort();
    const add = vi.spyOn(controller.signal, "addEventListener");

    await expect(awaitWithAbort(Promise.resolve("late"), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(add).not.toHaveBeenCalled();
  });

  it("ignores late settlement after aborting", async () => {
    const controller = new AbortController();
    let resolveOperation: (value: string) => void = () => {};
    const operation = new Promise<string>((resolve) => {
      resolveOperation = resolve;
    });
    const pending = awaitWithAbort(operation, controller.signal);

    controller.abort();
    resolveOperation("late");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(operation).resolves.toBe("late");
  });

  it("preserves operation rejections", async () => {
    const expected = new Error("operation failed");
    await expect(
      awaitWithAbort(Promise.reject(expected), new AbortController().signal),
    ).rejects.toBe(expected);
  });

  it.each(["resolve", "reject"] as const)("removes its listener after %s", async (settlement) => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const operation =
      settlement === "resolve" ? Promise.resolve("ok") : Promise.reject(new Error("failed"));

    await awaitWithAbort(operation, controller.signal).catch(() => undefined);

    expect(remove).toHaveBeenCalledOnce();
    expect(remove.mock.calls[0][0]).toBe("abort");
  });
});
