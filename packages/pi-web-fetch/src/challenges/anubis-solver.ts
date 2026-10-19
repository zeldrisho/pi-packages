import { createHash } from "node:crypto";

/** Maximum length in bytes of the server-provided random challenge data. */
export const ANUBIS_MAX_RANDOM_DATA_BYTES = 4_096;

/** Maximum size in bytes of a server-provided WebAssembly challenge module. */
export const ANUBIS_MAX_WASM_BYTES = 4 * 1_024 * 1_024;

/** A solved Anubis proof of work, using the nonce and hash the server expects. */
export interface AnubisSolution {
  nonce: number;
  hash: string;
}

/** A request to solve one Anubis challenge inside a worker thread. */
export type AnubisWorkerRequest =
  | {
      kind: "sha256";
      randomData: string;
      difficulty: number;
      deadline: number;
    }
  | {
      kind: "wasm";
      moduleBytes: Uint8Array;
      randomData: string;
      difficulty: number;
      deadline: number;
    };

/** The host function Anubis baseline WebAssembly modules import. */
const ANUBIS_WASM_IMPORT = { module: "anubis", name: "anubis_update_nonce" } as const;

/** Exports required from an Anubis baseline WebAssembly module. */
const ANUBIS_WASM_EXPORTS = [
  "data_ptr",
  "set_data_length",
  "anubis_work",
  "result_hash_ptr",
  "result_hash_size",
] as const;

/** Decodes a lowercase or uppercase hexadecimal string, rejecting odd or non-hex input. */
function decodeHex(value: string): Uint8Array | undefined {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value))
    return undefined;

  const bytes = new Uint8Array(value.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

/** Returns a defensive snapshot of a WebAssembly memory range. */
function readMemory(memory: WebAssembly.Memory, pointer: number, size: number): Uint8Array {
  const offset = pointer >>> 0;

  if (size < 0 || offset + size > memory.buffer.byteLength)
    throw new Error("Anubis challenge module returned an out-of-bounds pointer.");

  return new Uint8Array(memory.buffer, offset, size).slice();
}

/** Copies bytes into a validated WebAssembly memory range. */
function writeMemory(memory: WebAssembly.Memory, pointer: number, bytes: Uint8Array): void {
  const offset = pointer >>> 0;

  if (offset + bytes.byteLength > memory.buffer.byteLength)
    throw new Error("Anubis challenge module returned an out-of-bounds pointer.");

  new Uint8Array(memory.buffer, offset, bytes.byteLength).set(bytes);
}

/** Returns the number of leading zero bits in a byte sequence. */
function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;

  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
      continue;
    }

    bits += Math.clz32(byte) - 24;
    break;
  }

  return bits;
}

/** Narrows a WebAssembly export value to a numeric function. */
function isWasmFunction(
  value: WebAssembly.ExportValue | undefined,
): value is (...args: number[]) => number {
  return typeof value === "function";
}

/** Reads a required numeric function export from an instantiated module. */
function requireFunction(
  exports: WebAssembly.Exports,
  name: string,
): (...args: number[]) => number {
  const value = exports[name];

  if (!isWasmFunction(value)) throw new Error(`Anubis challenge module is missing ${name}.`);

  return value;
}

/**
 * Verifies that a module only imports the Anubis host function and exports the
 * interface the baseline solver needs, so a hostile server cannot pass a module
 * that reaches outside its sandbox.
 */
function assertSupportedModule(module: WebAssembly.Module): void {
  const imports = WebAssembly.Module.imports(module);

  if (
    imports.length !== 1 ||
    imports[0].module !== ANUBIS_WASM_IMPORT.module ||
    imports[0].name !== ANUBIS_WASM_IMPORT.name ||
    imports[0].kind !== "function"
  ) {
    throw new Error("Anubis challenge module requested unsupported imports.");
  }

  const exported = new Set(
    WebAssembly.Module.exports(module)
      .filter((entry) => entry.kind === "function")
      .map((entry) => entry.name),
  );

  for (const name of ANUBIS_WASM_EXPORTS) {
    if (!exported.has(name)) throw new Error(`Anubis challenge module is missing ${name}.`);
  }
}

/**
 * Solves a `fast` or `slow` challenge by searching for a nonce whose
 * `sha256(randomData + nonce)` has `difficulty` leading zero hexadecimal digits.
 *
 * @param randomData - The hex challenge string supplied by the server.
 * @param difficulty - Required number of leading zero hex digits.
 * @param deadline - Epoch milliseconds after which the search aborts.
 * @returns The matching nonce and its hex digest.
 */
export function solveAnubisSha256Hex(
  randomData: string,
  difficulty: number,
  deadline: number,
): AnubisSolution {
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 64)
    throw new Error("Anubis challenge requested an unsupported difficulty.");

  const prefix = "0".repeat(difficulty);

  for (let nonce = 0; nonce <= 0xffff_ffff; nonce += 1) {
    if ((nonce & 0xfff) === 0 && Date.now() > deadline)
      throw new Error("Anubis proof of work exceeded the time budget.");

    const hash = createHash("sha256").update(randomData).update(String(nonce)).digest("hex");

    if (hash.startsWith(prefix)) return { nonce, hash };
  }

  throw new Error("Anubis proof of work exhausted the nonce space.");
}

/**
 * Solves a `sha256`, `hashx`, or `argon2id` challenge by running the
 * server-provided baseline WebAssembly module inside this process.
 *
 * The module is validated before instantiation: it may import only the
 * `anubis_update_nonce` host function and must export the numeric interface the
 * baseline solver uses. The returned hash is checked against the requested
 * difficulty before it is submitted.
 *
 * @param moduleBytes - Compiled bytes of the baseline module.
 * @param randomData - The hex challenge string supplied by the server.
 * @param difficulty - Required number of leading zero bits in the result hash.
 * @param deadline - Epoch milliseconds after which the solve is abandoned.
 * @returns The matching nonce and its hex digest.
 */
export function solveAnubisWasm(
  moduleBytes: Uint8Array,
  randomData: string,
  difficulty: number,
  deadline: number,
): AnubisSolution {
  if (moduleBytes.byteLength === 0 || moduleBytes.byteLength > ANUBIS_MAX_WASM_BYTES)
    throw new Error("Anubis challenge module exceeded the size limit.");

  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 0xffff_ffff)
    throw new Error("Anubis challenge requested an unsupported difficulty.");

  const data = decodeHex(randomData);

  if (!data || data.byteLength > ANUBIS_MAX_RANDOM_DATA_BYTES)
    throw new Error("Anubis challenge supplied unsupported random data.");

  if (Date.now() > deadline) throw new Error("Anubis proof of work exceeded the time budget.");

  const module = new WebAssembly.Module(new Uint8Array(moduleBytes));
  assertSupportedModule(module);

  const instance = new WebAssembly.Instance(module, {
    anubis: { anubis_update_nonce: () => {} },
  });

  const memory = instance.exports.memory;

  if (!(memory instanceof WebAssembly.Memory))
    throw new Error("Anubis challenge module is missing memory.");

  const dataPtr = requireFunction(instance.exports, "data_ptr");
  const setDataLength = requireFunction(instance.exports, "set_data_length");
  const work = requireFunction(instance.exports, "anubis_work");
  const resultHashPtr = requireFunction(instance.exports, "result_hash_ptr");
  const resultHashSize = requireFunction(instance.exports, "result_hash_size");

  writeMemory(memory, dataPtr(), data);
  setDataLength(data.byteLength);
  const nonce = work(difficulty, 0, 1);
  const hashSize = resultHashSize() >>> 0;

  if (hashSize < 1 || hashSize > 4_096)
    throw new Error("Anubis challenge module returned an invalid hash size.");

  const hashBytes = readMemory(memory, resultHashPtr(), hashSize);

  if (Date.now() > deadline) throw new Error("Anubis proof of work exceeded the time budget.");

  if (difficulty > 0 && leadingZeroBits(hashBytes) < difficulty)
    throw new Error("Anubis proof of work produced an invalid solution.");

  const hash = Array.from(hashBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return { nonce: nonce >>> 0, hash };
}

/** Dispatches one worker solve request to the matching pure solver. */
export function solveAnubisRequest(request: AnubisWorkerRequest): AnubisSolution {
  if (request.kind === "sha256")
    return solveAnubisSha256Hex(request.randomData, request.difficulty, request.deadline);

  return solveAnubisWasm(
    request.moduleBytes,
    request.randomData,
    request.difficulty,
    request.deadline,
  );
}
