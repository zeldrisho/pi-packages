import { createHash, randomUUID } from "node:crypto";

/** Identifiers sent with each request so the backend can group a conversation. */
export interface RequestIdentity {
  conversationId: string;
  trajectoryId: string;
  sessionId: string;
}

/**
 * Derives a deterministic UUID-shaped id from a seed.
 *
 * @param seed - Stable seed for this identifier
 * @returns A UUID-shaped identifier
 */
export function stableUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Derives the signed 64-bit session id the backend expects.
 *
 * @param seed - Stable seed, normally Pi's session id
 * @returns A signed 64-bit integer rendered as a decimal string
 */
export function int64SessionId(seed: string): string {
  if (/^-?\d+$/.test(seed)) {
    const value = BigInt(seed);

    if (value >= -(2n ** 63n) && value <= 2n ** 63n - 1n) return seed;
  }

  const digest = createHash("sha256").update(`antigravity:session:${seed}`).digest();

  return String(new DataView(digest.buffer, digest.byteOffset, 8).getBigInt64(0, true));
}

/**
 * Resolves request identifiers, preferring Pi's session id so a session keeps one
 * backend conversation across turns.
 *
 * @param sessionId - Pi session id for this request, when available
 * @returns Identifiers for the request envelope
 */
export function resolveIdentity(sessionId: string | undefined): RequestIdentity {
  if (sessionId === undefined || sessionId.trim() === "") {
    const random = randomUUID();

    return {
      conversationId: random,
      trajectoryId: randomUUID(),
      sessionId: int64SessionId(random),
    };
  }

  const seed = `session:${sessionId.trim()}`;

  return {
    conversationId: stableUuid(`antigravity:conv:${seed}`),
    trajectoryId: stableUuid(`antigravity:traj:${seed}`),
    sessionId: int64SessionId(sessionId.trim()),
  };
}
