import { createHash, scryptSync } from "node:crypto";

/** Returns whether the first `difficulty` bits of a hash are zero. */
export function hasLeadingZeroBits(hash, difficulty) {
  for (let bit = 0; bit < difficulty; bit += 1) {
    const byte = hash[Math.floor(bit / 8)];

    if (byte === undefined || (byte & (1 << (7 - (bit % 8)))) !== 0) return false;
  }

  return true;
}

/** Solves the bandwidth challenge using a bounded zero-filled buffer. */
export function solveAwsWafBandwidth(difficulty) {
  const sizes = [1_024, 1_024, 10_240, 102_400, 1_048_576, 10_485_760];

  return Buffer.alloc(sizes[Math.min(5, Math.max(0, difficulty))] ?? 1_024).toString("base64");
}

/** Computes bounded proof-of-work inside a disposable worker. */
export function solveAwsWafWork(work) {
  if (!Number.isInteger(work.difficulty) || work.difficulty < 1 || work.difficulty > 32)
    return undefined;

  if (work.type === "NetworkBandwidth") return solveAwsWafBandwidth(work.difficulty);

  if (work.type === "SHA256") {
    for (let nonce = 0; nonce < 2_000_000; nonce += 1) {
      const digest = createHash("sha256").update(`${work.input}${work.checksum}${nonce}`).digest();

      if (hasLeadingZeroBits(digest, work.difficulty)) return String(nonce);
    }
  }

  if (work.type === "HashcashScrypt") {
    const cost = work.memory > 0 ? work.memory : 128;

    // Reject large or invalid costs before invoking OpenSSL.
    if (!Number.isInteger(cost) || cost < 2 || cost > 16_384 || (cost & (cost - 1)) !== 0)
      return undefined;

    for (let nonce = 0; nonce < 100_000; nonce += 1) {
      const digest = scryptSync(`${work.input}${work.checksum}${nonce}`, work.checksum, 32, {
        N: cost,
        r: 8,
        p: 1,
        maxmem: 64 * 1_024 * 1_024,
      });

      if (hasLeadingZeroBits(digest, work.difficulty)) return String(nonce);
    }
  }

  return undefined;
}
