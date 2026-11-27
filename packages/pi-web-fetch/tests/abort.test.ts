import { describe, expect, it, vi } from "vite-plus/test";
import { awaitWithAbort } from "../src/abort";

describe("awaitWithAbort", () => {
  it("rejects an already-aborted signal", async () => {
    await expect(
      awaitWithAbort(Promise.resolve("late"), AbortSignal.abort()),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
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
  });

  it.each([
    { settlement: "success", value: "ok" },
    { settlement: "failure", error: new Error("operation failed") },
  ])("preserves $settlement and detaches the abort listener", async ({ error, value }) => {
    const { signal } = new AbortController();
    const add = vi.spyOn(signal, "addEventListener");
    const remove = vi.spyOn(signal, "removeEventListener");
    const pending = awaitWithAbort(error ? Promise.reject(error) : Promise.resolve(value), signal);

    if (error) await expect(pending).rejects.toBe(error);
    else await expect(pending).resolves.toBe(value);

    const listener = add.mock.calls.find(([event]) => event === "abort")?.[1];
    expect(listener).toBeTypeOf("function");
    expect(remove).toHaveBeenCalledWith("abort", listener);
  });
});
