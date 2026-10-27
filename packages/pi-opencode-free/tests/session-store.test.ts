import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { createCanonicalSessionId } from "../src/fingerprint";
import {
  createSessionStore,
  isReusableSessionId,
  parseSessionRecord,
  resolveSessionId,
  SESSION_FUTURE_TOLERANCE_MS,
  SESSION_REUSE_MS,
  sessionStorePath,
} from "../src/session-store";

const NOW = 1_793_000_000_000;

const DAY_MS = 24 * 60 * 60 * 1000;

function seed(value = 0): Uint8Array {
  return Uint8Array.from({ length: 20 }, (_, index) => (index + value) % 256);
}

function identityAt(offset: number, value = 0): string {
  return createCanonicalSessionId(seed(value), NOW - offset);
}

function memoryStore(initial?: string) {
  const saved: string[] = [];
  const state = { id: initial, saved };

  return {
    state,
    load: () => state.id,
    save: (id: string) => {
      state.id = id;
      state.saved.push(id);
    },
  };
}

describe("session identity reuse", () => {
  it("creates and persists an identity when the store is empty", () => {
    const store = memoryStore();

    const id = resolveSessionId({ now: NOW, create: () => identityAt(0), store });

    expect(id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/u);
    expect(store.state.saved).toEqual([id]);
    expect(store.state.id).toBe(id);
  });

  it("reuses a stored identity instead of creating a new one", () => {
    const stored = identityAt(DAY_MS);
    const store = memoryStore(stored);

    expect(resolveSessionId({ now: NOW, create: () => identityAt(0), store })).toBe(stored);
    expect(store.state.saved).toEqual([]);
  });

  it("prefers a reusable override and persists it", () => {
    const stored = identityAt(DAY_MS);
    const override = identityAt(2 * DAY_MS, 1);
    const store = memoryStore(stored);

    expect(resolveSessionId({ now: NOW, create: () => identityAt(0), store, override })).toBe(
      override,
    );
    expect(store.state.saved).toEqual([override]);
  });

  it("ignores an override older than the reuse window", () => {
    const stored = identityAt(DAY_MS);
    const store = memoryStore(stored);
    const stale = identityAt(SESSION_REUSE_MS + DAY_MS);

    expect(
      resolveSessionId({ now: NOW, create: () => identityAt(0), store, override: stale }),
    ).toBe(stored);
    expect(store.state.saved).toEqual([]);
  });

  it("ignores malformed and far-future overrides", () => {
    const stored = identityAt(DAY_MS);
    const store = memoryStore(stored);
    const future = identityAt(-(SESSION_FUTURE_TOLERANCE_MS + DAY_MS));

    for (const override of ["not-a-session", "ses_", "", future]) {
      expect(resolveSessionId({ now: NOW, create: () => identityAt(0), store, override })).toBe(
        stored,
      );
    }
  });

  it("accepts a slightly future-dated identity for clock drift", () => {
    const drifted = identityAt(-60_000);

    expect(isReusableSessionId(drifted, NOW)).toBe(true);
  });

  it("rejects identities at or beyond the reuse window", () => {
    expect(isReusableSessionId(identityAt(SESSION_REUSE_MS - 1), NOW)).toBe(true);
    expect(isReusableSessionId(identityAt(SESSION_REUSE_MS), NOW)).toBe(false);
  });
});

describe("persisted session records", () => {
  it("accepts a current record and rejects malformed or stale ones", () => {
    const id = identityAt(DAY_MS);

    expect(parseSessionRecord({ version: 1, id, createdAt: NOW }, NOW)).toEqual({
      id,
      createdAt: NOW,
    });
    expect(parseSessionRecord({ version: 2, id, createdAt: NOW }, NOW)).toBeUndefined();
    expect(parseSessionRecord({ id, createdAt: NOW }, NOW)).toBeUndefined();
    expect(parseSessionRecord({ version: 1, id: "ses_bad", createdAt: NOW }, NOW)).toBeUndefined();
    expect(parseSessionRecord(null, NOW)).toBeUndefined();

    const stale = identityAt(SESSION_REUSE_MS + DAY_MS);

    expect(parseSessionRecord({ version: 1, id: stale, createdAt: NOW }, NOW)).toBeUndefined();
  });

  it("round-trips through the JSON file and creates missing directories", () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-free-session-"));

    try {
      const path = sessionStorePath(directory);
      const store = createSessionStore(path);
      const id = identityAt(0);

      expect(store.load(NOW)).toBeUndefined();

      store.save(id, NOW);

      expect(store.load(NOW)).toBe(id);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        version: 1,
        id,
        createdAt: NOW,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("falls back to no identity for unreadable or corrupt files", () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-free-session-"));
    const path = sessionStorePath(directory);

    try {
      const store = createSessionStore(path);

      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "{not json");

      expect(store.load(NOW)).toBeUndefined();

      writeFileSync(path, JSON.stringify({ version: 1, id: "ses_bad", createdAt: NOW }));

      expect(store.load(NOW)).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
