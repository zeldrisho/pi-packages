import { describe, expect, it, vi } from "vite-plus/test";
import { createCaptureFetch, renderEvidence } from "../scripts/request-capture.ts";

describe("request capture", () => {
  it("sanitizes credentials, query secrets, bodies and response payloads", async () => {
    const upstream = vi.fn(async () => new Response("private response", { status: 200 }));
    const capture = createCaptureFetch(upstream, () => "fixed-time");
    await capture.fetch("https://example.test/inference?code=secret&q=visible", {
      method: "POST",
      headers: { Authorization: "Bearer secret", "x-opencode-session": "ses_value" },
      body: JSON.stringify({ apiKey: "secret", model: "free", messages: [] }),
    });
    const snapshot = JSON.stringify(capture.snapshot());
    expect(snapshot).not.toContain("Bearer secret");
    expect(snapshot).not.toContain("secret");
    expect(snapshot).not.toContain("private response");
    expect(snapshot).toContain("[redacted]");
    expect(snapshot).toContain("ses_value");
    expect(snapshot).toContain("code=%5Bredacted%5D");
    expect(snapshot).toContain('"fields":["model","messages"]');
    expect(snapshot).toContain('"status":200');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("records failures, handles header forms and clears snapshots", async () => {
    const capture = createCaptureFetch(async () => {
      throw new Error("private network error");
    });

    const request = new Request("https://example.test/v1", {
      headers: new Headers({ Cookie: "secret" }),
    });

    await expect(capture.fetch(request)).rejects.toThrow("private network error");
    expect(JSON.stringify(capture.snapshot())).not.toContain("private network error");
    expect(JSON.stringify(capture.snapshot())).not.toContain("secret");
    capture.clear();
    expect(capture.snapshot().events).toEqual([]);
  });

  it("renders evidence with explicit classes", () => {
    expect(renderEvidence("test?", ["- observed"], ["- inferred"], ["- unknown"])).toMatch(
      /## Observed\n- observed/,
    );
  });
});
