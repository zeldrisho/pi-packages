import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  ANUBIS_MAX_WASM_BYTES,
  solveAnubisRequest,
  solveAnubisSha256Hex,
  solveAnubisWasm,
} from "../../src/anubis-solver";

const fixture = readFileSync(new URL("../fixtures/anubis-sha256.wasm", import.meta.url));

/** Counts leading zero bits in a lowercase hex digest. */
function leadingZeroBits(hex: string): number {
  let bits = 0;

  for (let index = 0; index < hex.length; index += 2) {
    const byte = Number.parseInt(hex.slice(index, index + 2), 16);

    if (byte === 0) {
      bits += 8;
      continue;
    }

    bits += Math.clz32(byte) - 24;
    break;
  }

  return bits;
}

describe("solveAnubisSha256Hex", () => {
  it("finds a nonce matching the requested hex difficulty", () => {
    const solution = solveAnubisSha256Hex("deadbeef", 2, Date.now() + 5_000);

    const expected = createHash("sha256")
      .update("deadbeef")
      .update(String(solution.nonce))
      .digest("hex");

    expect(solution.hash).toBe(expected);
    expect(solution.hash.startsWith("00")).toBe(true);
  });

  it("returns the first hash at difficulty zero", () => {
    expect(solveAnubisSha256Hex("cafe", 0, Date.now() + 1_000).nonce).toBe(0);
  });

  it("rejects an unsupported difficulty", () => {
    expect(() => solveAnubisSha256Hex("cafe", 65, Date.now() + 1_000)).toThrow(
      /unsupported difficulty/,
    );
  });

  it("stops once the deadline passes", () => {
    expect(() => solveAnubisSha256Hex("cafe", 64, Date.now() - 1)).toThrow(/time budget/);
  });
});

describe("solveAnubisWasm", () => {
  it("runs the baseline sha256 module and returns a valid solution", () => {
    const randomData = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const solution = solveAnubisWasm(fixture, randomData, 8, Date.now() + 5_000);

    expect(leadingZeroBits(solution.hash)).toBeGreaterThanOrEqual(8);
    expect(solution.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isInteger(solution.nonce)).toBe(true);

    const data = Buffer.from(randomData, "hex");

    const be = Buffer.from([
      (solution.nonce >>> 24) & 0xff,
      (solution.nonce >>> 16) & 0xff,
      (solution.nonce >>> 8) & 0xff,
      solution.nonce & 0xff,
    ]);

    const le = Buffer.from([...be].reverse());

    const digest = (suffix: Buffer) =>
      createHash("sha256")
        .update(Buffer.concat([data, suffix]))
        .digest("hex");

    expect([digest(be), digest(le)]).toContain(solution.hash);
  });

  it("rejects an empty module", () => {
    expect(() => solveAnubisWasm(new Uint8Array(0), "00", 0, Date.now() + 1_000)).toThrow(
      /size limit/,
    );
  });

  it("rejects an oversized module", () => {
    expect(() =>
      solveAnubisWasm(new Uint8Array(ANUBIS_MAX_WASM_BYTES + 1), "00", 0, Date.now() + 1_000),
    ).toThrow(/size limit/);
  });

  it("rejects a module without the required imports", () => {
    const empty = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

    expect(() => solveAnubisWasm(empty, "00", 0, Date.now() + 1_000)).toThrow(
      /unsupported imports/,
    );
  });

  it("rejects non-hex random data", () => {
    expect(() => solveAnubisWasm(fixture, "xyz", 0, Date.now() + 1_000)).toThrow(
      /unsupported random data/,
    );
  });

  it("rejects an unsupported difficulty", () => {
    expect(() => solveAnubisWasm(fixture, "00", 0x1_0000_0000, Date.now() + 1_000)).toThrow(
      /unsupported difficulty/,
    );
  });

  it("stops once the deadline passes", () => {
    expect(() => solveAnubisWasm(fixture, "00", 0, Date.now() - 1)).toThrow(/time budget/);
  });
});

describe("solveAnubisRequest", () => {
  it("dispatches sha256 requests", () => {
    const solution = solveAnubisRequest({
      kind: "sha256",
      randomData: "ab",
      difficulty: 1,
      deadline: Date.now() + 1_000,
    });

    expect(solution.hash.startsWith("0")).toBe(true);
  });

  it("dispatches wasm requests", () => {
    const solution = solveAnubisRequest({
      kind: "wasm",
      moduleBytes: fixture,
      randomData: "ab",
      difficulty: 4,
      deadline: Date.now() + 5_000,
    });

    expect(leadingZeroBits(solution.hash)).toBeGreaterThanOrEqual(4);
  });
});
