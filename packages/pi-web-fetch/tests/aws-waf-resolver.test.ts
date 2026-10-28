import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createServer, type IncomingMessage, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import {
  extractAwsWafChallenge,
  nativeAwsWafResolver,
} from "../src/challenges/aws-waf-resolver.ts";
import {
  hasLeadingZeroBits,
  solveAwsWafBandwidth,
  solveAwsWafWork,
} from "../src/challenges/aws-waf-solver.ts";
import { requestPinned, type FetchRemoteDependencies } from "../src/index.ts";

/** Starts a loopback HTTP server and returns its base URL and cleanup function. */
async function listen(handler: RequestListener) {
  const server = createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  // SAFETY: the server has successfully listened on a TCP port above.
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Reads a complete request body for challenge payload assertions. */
async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) chunks.push(Buffer.from(chunk));

  return Buffer.concat(chunks).toString("utf8");
}

const challengePath = "/__challenge_abc/012345/abcdef";

interface ChallengeOptions {
  challengeType?: string;
  difficulty?: number;
  memory?: number;
  pageStatus?: number;
  pageBody?: string;
  inputsStatus?: number;
  inputsBody?: string;
  postStatus?: number;
  postBodies?: string[];
  includeGoku?: boolean;
  omitRequest?: boolean;
}

interface ChallengeInput {
  input: string;
  payload: {
    challenge: { input: string; region: string };
    challenge_type: string;
    difficulty: number;
    memory: number;
  };
}

/** Builds a base64 challenge input and the matching `/inputs` response. */
function createChallengeInput(
  challengeType: string,
  difficulty: number,
  memory: number,
  includeMetadata = true,
): ChallengeInput {
  const decoded = includeMetadata ? { challenge_type: challengeType, difficulty, memory } : {};
  const input = Buffer.from(JSON.stringify(decoded)).toString("base64");

  return {
    input,
    payload: {
      challenge: { input, region: "test" },
      challenge_type: challengeType,
      difficulty,
      memory,
    },
  };
}

interface ChallengeHarness {
  url: string;
  postedBodies: string[];
  postedUrls: string[];
  dependencies: FetchRemoteDependencies;
  close(): Promise<void>;
}

/** Starts a server that emulates the page, inputs, and submission endpoints. */
async function startChallenge(options: ChallengeOptions = {}): Promise<ChallengeHarness> {
  const challenge = createChallengeInput(
    options.challengeType ?? "h7b0c470f0123456789",
    options.difficulty ?? 1,
    options.memory ?? 128,
  );

  const postedBodies: string[] = [];
  const postedUrls: string[] = [];
  const postBodies = options.postBodies ?? [JSON.stringify({ token: "native-token" })];

  const pageHtml =
    options.pageBody ??
    [
      options.includeGoku === false ? "" : '<script>window.gokuProps = {"key":"test"}</script>',
      `<script src="${challengePath}/challenge.js"></script>`,
    ].join("");

  const server = await listen(async (request, response) => {
    if (request.url === "/page") {
      response.writeHead(options.pageStatus ?? 202, {
        "content-type": "text/html",
        "x-amzn-waf-action": "challenge",
      });
      response.end(pageHtml);

      return;
    }

    if (request.url === `${challengePath}/inputs?client=browser`) {
      response.writeHead(options.inputsStatus ?? 200, { "content-type": "application/json" });
      response.end(options.inputsBody ?? JSON.stringify(challenge.payload));

      return;
    }

    if (request.url === `${challengePath}/verify` || request.url === `${challengePath}/mp_verify`) {
      postedUrls.push(request.url);
      postedBodies.push(await requestBody(request));
      const body = postBodies.length > 1 ? (postBodies.shift() ?? "{}") : (postBodies[0] ?? "{}");
      response.writeHead(options.postStatus ?? 200, { "content-type": "application/json" });
      response.end(body);

      return;
    }

    response.writeHead(404);
    response.end();
  });

  const dependencies: FetchRemoteDependencies = {
    validateUrl: async (value) => {
      const url = value instanceof URL ? value : new URL(value);

      return { url, address: "127.0.0.1", family: 4, addresses: ["127.0.0.1"] };
    },
  };

  if (!options.omitRequest) {
    dependencies.request = (target, signal, headers, requestOptions) =>
      requestPinned(target, signal, {
        headers,
        method: requestOptions?.method,
        body: requestOptions?.body,
      });
  }

  return {
    url: server.url,
    postedBodies,
    postedUrls,
    dependencies,
    close: async () => await server.close(),
  };
}

/** Resolves the challenge served by a harness. */
async function resolveChallenge(harness: ChallengeHarness) {
  return await nativeAwsWafResolver.resolve({
    url: new URL(`${harness.url}/page`),
    signal: new AbortController().signal,
    network: harness.dependencies,
  });
}

describe("native AWS WAF helpers", () => {
  it("checks leading zero bits without reading past the digest", () => {
    expect(hasLeadingZeroBits(new Uint8Array([0x00, 0xff]), 8)).toBe(true);
    expect(hasLeadingZeroBits(new Uint8Array([0x00, 0xff]), 9)).toBe(false);
    expect(hasLeadingZeroBits(new Uint8Array([0x80]), 1)).toBe(false);
    expect(hasLeadingZeroBits(new Uint8Array([]), 1)).toBe(false);
  });

  it("returns the requested zeroed bandwidth payload", () => {
    for (const [difficulty, size] of [
      [0, 1_024],
      [1, 1_024],
      [2, 10_240],
      [3, 102_400],
      [4, 1_048_576],
      [5, 10_485_760],
    ]) {
      expect(Buffer.from(solveAwsWafBandwidth(difficulty), "base64")).toHaveLength(size);
    }
  });

  it("bounds and solves proof-of-work inputs", () => {
    const work = { type: "SHA256", input: "input", checksum: "sum", difficulty: 1, memory: 128 };
    expect(solveAwsWafWork(work)).toEqual(expect.any(String));
    expect(solveAwsWafWork({ ...work, type: "HashcashScrypt" })).toEqual(expect.any(String));
    expect(solveAwsWafWork({ ...work, type: "HashcashScrypt", memory: 3 })).toBeUndefined();
    expect(solveAwsWafWork({ ...work, type: "NetworkBandwidth" })).toEqual(expect.any(String));
    expect(solveAwsWafWork({ ...work, difficulty: 33 })).toBeUndefined();
    expect(solveAwsWafWork({ ...work, type: "unknown" })).toBeUndefined();
  });

  it("extracts external challenge URLs and goku properties", () => {
    const html = [
      '<script>window.gokuProps = {"key":"test"}</script>',
      '<script src="https://abc.def.ap-southeast-1.token.awswaf.com/abc/def/ghi/challenge.js"></script>',
    ].join("");

    expect(extractAwsWafChallenge(html, new URL("https://example.test/"))).toEqual({
      challengeUrl: "https://abc.def.ap-southeast-1.token.awswaf.com/abc/def/ghi",
      gokuProps: { key: "test" },
    });
  });

  it("extracts same-origin and SDK challenge URLs", () => {
    expect(
      extractAwsWafChallenge(
        `<script src="${challengePath}/challenge.js"></script>`,
        new URL("https://example.test/docs/page"),
      ),
    ).toEqual({ challengeUrl: "https://example.test/__challenge_abc/012345/abcdef" });
    expect(
      extractAwsWafChallenge(
        '<script src="https://abc.edge.sdk.awswaf.com/abc/def/challenge.js"></script>',
        new URL("https://example.test/"),
      ),
    ).toEqual({ challengeUrl: "https://abc.edge.sdk.awswaf.com/abc/def" });
  });

  it("returns undefined when no challenge is present", () => {
    expect(extractAwsWafChallenge("<html>plain</html>", new URL("https://example.test/"))).toBe(
      undefined,
    );
  });
});

describe("native AWS WAF resolver", () => {
  let server: ChallengeHarness;

  beforeAll(async () => {
    server = await startChallenge();
  });

  afterAll(async () => {
    await server.close();
  });

  it("solves a SHA256 challenge and returns a browser-bound token", async () => {
    const solution = await resolveChallenge(server);

    expect(solution?.token).toBe("native-token");
    expect(solution?.userAgent).toContain("Chrome/");
    expect(server.postedBodies).toHaveLength(1);

    const payload = JSON.parse(server.postedBodies[0] ?? "{}");
    expect(payload.client).toBe("Browser");
    expect(payload.solution).toEqual(expect.any(String));
    expect(payload.signals).toHaveLength(1);
  });

  it("solves a bandwidth challenge through the multipart endpoint", async () => {
    const bandwidth = await startChallenge({
      challengeType: "ha9faaffd0123456789",
      difficulty: 3,
      includeGoku: false,
    });

    try {
      const solution = await resolveChallenge(bandwidth);

      expect(solution?.token).toBe("native-token");
      expect(bandwidth.postedUrls[0]).toBe(`${challengePath}/mp_verify`);
      expect(bandwidth.postedBodies[0]).toContain('name="solution_metadata"');
      expect(bandwidth.postedBodies[0]).toContain('"goku_props":null');
    } finally {
      await bandwidth.close();
    }
  });

  it("solves a scrypt challenge with a zero memory fallback", async () => {
    const scrypt = await startChallenge({
      challengeType: "h72f957df0123456789",
      difficulty: 1,
      memory: 0,
    });

    try {
      await expect(resolveChallenge(scrypt)).resolves.toEqual({
        token: "native-token",
        userAgent: expect.stringContaining("Chrome/"),
      });
    } finally {
      await scrypt.close();
    }
  });

  it("falls back to top-level challenge metadata", async () => {
    const fallback = await startChallenge({
      challengeType: "h7b0c470f0123456789",
      difficulty: 1,
      memory: 128,
      inputsBody: JSON.stringify({
        ...createChallengeInput("h7b0c470f0123456789", 1, 128, false).payload,
      }),
    });

    try {
      await expect(resolveChallenge(fallback)).resolves.toMatchObject({ token: "native-token" });
    } finally {
      await fallback.close();
    }
  });

  it("uses replacement inputs and a nested token response", async () => {
    const replacement = createChallengeInput("h7b0c470f0123456789", 1, 128);

    const retry = await startChallenge({
      postBodies: [
        JSON.stringify({ response: { inputs: replacement.payload } }),
        JSON.stringify({ response: { token: "nested-token" } }),
      ],
    });

    try {
      await expect(resolveChallenge(retry)).resolves.toMatchObject({ token: "nested-token" });
      expect(retry.postedBodies).toHaveLength(2);
    } finally {
      await retry.close();
    }
  });

  it("returns undefined when the page is not a challenge or cannot be read", async () => {
    const missing = await startChallenge({ pageStatus: 404 });
    const plain = await startChallenge({ pageStatus: 200, pageBody: "<html>plain</html>" });

    try {
      await expect(resolveChallenge(missing)).resolves.toBeUndefined();
      await expect(resolveChallenge(plain)).resolves.toBeUndefined();
    } finally {
      await missing.close();
      await plain.close();
    }
  });

  it("returns undefined for failed or malformed challenge metadata", async () => {
    const failed = await startChallenge({ inputsStatus: 503 });
    const malformed = await startChallenge({ inputsBody: "not json" });
    const array = await startChallenge({ inputsBody: "[]" });
    const missingChallenge = await startChallenge({ inputsBody: "{}" });

    const missingInput = await startChallenge({
      inputsBody: JSON.stringify({ challenge: {}, challenge_type: "h7b0c470f0123456789" }),
    });

    const missingType = await startChallenge({
      inputsBody: JSON.stringify({ challenge: { input: "e30=" } }),
    });

    try {
      await expect(resolveChallenge(failed)).resolves.toBeUndefined();
      await expect(resolveChallenge(malformed)).resolves.toBeUndefined();
      await expect(resolveChallenge(array)).resolves.toBeUndefined();
      await expect(resolveChallenge(missingChallenge)).resolves.toBeUndefined();
      await expect(resolveChallenge(missingInput)).resolves.toBeUndefined();
      await expect(resolveChallenge(missingType)).resolves.toBeUndefined();
    } finally {
      await failed.close();
      await malformed.close();
      await array.close();
      await missingChallenge.close();
      await missingInput.close();
      await missingType.close();
    }
  });

  it("returns undefined for failed submissions and unsupported work", async () => {
    const failed = await startChallenge({ postStatus: 500 });
    const noToken = await startChallenge({ postBodies: [JSON.stringify({})] });
    const unsupported = await startChallenge({ challengeType: "custom-challenge" });
    const invalidDifficulty = await startChallenge({ difficulty: 0 });

    try {
      await expect(resolveChallenge(failed)).resolves.toBeUndefined();
      await expect(resolveChallenge(noToken)).resolves.toBeUndefined();
      await expect(resolveChallenge(unsupported)).resolves.toBeUndefined();
      await expect(resolveChallenge(invalidDifficulty)).resolves.toBeUndefined();
    } finally {
      await failed.close();
      await noToken.close();
      await unsupported.close();
      await invalidDifficulty.close();
    }
  });

  it("cancels expensive work without blocking the event loop", async () => {
    const expensive = await startChallenge({ difficulty: 32 });
    const controller = new AbortController();

    try {
      const pending = nativeAwsWafResolver.resolve({
        url: new URL(`${expensive.url}/page`),
        signal: controller.signal,
        network: expensive.dependencies,
      });

      setTimeout(() => controller.abort(), 100);
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(expensive.postedBodies).toHaveLength(0);
    } finally {
      await expensive.close();
    }
  });

  it("uses the pinned transport when no request override is supplied", async () => {
    const pinned = await startChallenge({ omitRequest: true });

    try {
      await expect(resolveChallenge(pinned)).resolves.toMatchObject({ token: "native-token" });
    } finally {
      await pinned.close();
    }
  });
});
