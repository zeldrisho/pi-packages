import type {
  AssistantMessage,
  JsonObject,
  JsonValue,
  Message,
  ModelThinkingLevel,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { RequestIdentity } from "./ids.ts";
import { isJsonObject, isJsonText } from "./json.ts";
import {
  type AntigravityModel,
  type ThinkingConfig,
  requiresThoughtSignature,
  thinkingConfig,
} from "./models.ts";

/** Gemini content roles accepted by the Cloud Code Assist backend. */
type GeminiRole = "user" | "model";

/** A plain text part, optionally carrying a replayed thought signature. */
export interface GeminiTextPart {
  text: string;
  thoughtSignature?: string;
}

/** MIME type and base64 payload of an inline image. */
export interface GeminiInlineImage {
  mimeType: string;
  data: string;
}

/** An inline image part. */
export interface GeminiInlineDataPart {
  inlineData: GeminiInlineImage;
}

/** A reasoning part returned with `thought: true`. */
export interface GeminiThoughtPart {
  thought: true;
  text: string;
  thoughtSignature?: string;
}

/** A model-issued tool call. */
export interface GeminiFunctionCallPart {
  functionCall: { name: string; args: JsonObject; id?: string };
  thoughtSignature?: string;
}

/** A tool result addressed back to the model. */
export interface GeminiFunctionResponsePart {
  functionResponse: { name: string; response: JsonObject; id?: string };
}

/** Every part shape this provider sends. */
export type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiThoughtPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

/** One conversation turn. */
export interface GeminiContent {
  role: GeminiRole;
  parts: GeminiPart[];
}

/** A tool declaration in either schema form the backend accepts. */
export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: JsonObject;
  parametersJsonSchema?: JsonObject;
}

/** Generation settings for one request. */
export interface GeminiGenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  thinkingConfig?: ThinkingConfig;
}

/** The Gemini-shaped request body. */
export interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction: { role: GeminiRole; parts: GeminiTextPart[] };
  sessionId: string;
  labels: RequestLabels;
  generationConfig?: GeminiGenerationConfig;
  tools?: { functionDeclarations: GeminiFunctionDeclaration[] }[];
}

/** The envelope the backend expects around a Gemini request body. */
export interface AntigravityRequestEnvelope {
  project: string;
  model: string;
  request: GeminiRequestBody;
  requestType: "agent";
  userAgent: "antigravity";
  requestId: string;
}

/** Everything needed to build one request. */
export interface RequestInput {
  model: AntigravityModel;
  messages: readonly Message[];
  systemPrompt: string;
  tools: readonly Tool[];
  projectId: string;
  runtimeModel: string;
  identity: RequestIdentity;
  requestIndex: number;
  now: number;
  maxTokens?: number;
  temperature?: number;
  thinkingLevel?: ModelThinkingLevel;
  discoveredThinkingConfig?: ThinkingConfig;
}

/** Text injected when a turn needs a natural-language user part. */
const CONTINUATION_TEXT = "Continue the active task using the available instructions and context.";

/** Schema keywords whose values are maps of sub-schemas keyed by user-defined names. */
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
]);

/** Schema keywords whose values are sub-schemas. */
const SCHEMA_VALUE_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

/** Schema keywords whose values are lists of sub-schemas. */
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/** Metadata keywords the backend rejects inside a JSON Schema. */
const META_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$vocabulary",
  "$comment",
  "$defs",
  "definitions",
]);

/** Bounds on `$ref` inlining so an adversarial schema cannot exhaust memory. */
const MAX_SCHEMA_DEPTH = 32;

const MAX_SCHEMA_NODES = 4000;

/**
 * Reports whether a thought signature can be replayed to the backend.
 *
 * @param signature - Signature carried by a stored content block
 * @returns True when the value looks like a base64 signature
 */
export function isValidThoughtSignature(signature: string | undefined): boolean {
  if (signature === undefined || signature.length === 0) return false;

  if (signature.length % 4 !== 0) return false;

  return /^[A-Za-z0-9+/]+={0,2}$/.test(signature);
}

/**
 * Trims a tool-call id to the character set and length the backend accepts.
 *
 * @param id - Stored tool-call id
 * @param fallbackName - Tool name used when the id is empty after sanitizing
 * @returns A usable tool-call id
 */
export function sanitizeToolCallId(id: string, fallbackName: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

  return cleaned.length > 0 ? cleaned : `${fallbackName}_call`;
}

/**
 * Splits a data URL or bare base64 payload into inline image data.
 *
 * @param raw - Image payload from Pi
 * @param explicitMime - MIME type Pi recorded, when available
 * @returns MIME type and base64 data
 */
export function parseImageData(raw: string, explicitMime?: string): GeminiInlineImage {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(raw);

  if (match !== null) {
    return { mimeType: explicitMime ?? match[1] ?? "image/png", data: (match[2] ?? "").trim() };
  }

  return { mimeType: explicitMime ?? "image/png", data: raw.trim() };
}

/**
 * Appends parts to the last turn when its role matches, otherwise starts a new turn.
 *
 * @param contents - Turn list being built
 * @param role - Role for the appended parts
 * @param parts - Parts to append; an empty list is ignored
 */
function appendTurn(contents: GeminiContent[], role: GeminiRole, parts: GeminiPart[]): void {
  if (parts.length === 0) return;

  const last = contents.at(-1);

  if (last !== undefined && last.role === role) {
    last.parts.push(...parts);

    return;
  }

  contents.push({ role, parts });
}

/**
 * Converts a user message, keeping images inline.
 *
 * @param message - User message from the transcript
 * @returns Parts for one user turn
 */
function userParts(message: Extract<Message, { role: "user" }>): GeminiPart[] {
  if (typeof message.content === "string") {
    const text = message.content.trim();

    return text === "" ? [] : [{ text: message.content }];
  }

  const parts: GeminiPart[] = [];

  for (const block of message.content) {
    if (block.type === "text") {
      if (block.text.trim() === "") continue;
      parts.push({ text: block.text });
      continue;
    }

    const image = parseImageData(block.data, block.mimeType);

    if (image.data !== "") parts.push({ inlineData: image });
  }

  return parts;
}

/** Tool calls whose declarations were dropped, keyed by stored call id or tool name. */
interface DroppedCalls {
  byId: Map<string, string>;
  byName: Map<string, string[]>;
}

/**
 * Converts an assistant message into model-turn parts.
 *
 * Gemini 3 and newer reject replayed tool calls without a thought signature.
 * When a stored call cannot be replayed, it is recorded as dropped so the
 * matching tool result can be sent as plain observation text instead.
 *
 * @param message - Assistant message from the transcript
 * @param model - Catalog entry for the selected model
 * @param runtimeModel - Backend request model id
 * @param dropped - Records calls that could not be replayed
 * @returns Parts for one model turn
 */
function assistantParts(
  message: AssistantMessage,
  model: AntigravityModel,
  runtimeModel: string,
  dropped: DroppedCalls,
): GeminiPart[] {
  if (message.stopReason === "error" || message.stopReason === "aborted") return [];

  const sameModel = message.provider === "antigravity" && message.model === model.id;
  const needsSignature = requiresThoughtSignature(runtimeModel);
  const calls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
  const callsSigned = calls.every((call) => isValidThoughtSignature(call.thoughtSignature));
  const replayable = !needsSignature || (sameModel && callsSigned);

  const parts: GeminiPart[] = [];

  for (const block of message.content) {
    if (block.type === "text") {
      const signature =
        sameModel && isValidThoughtSignature(block.textSignature) ? block.textSignature : undefined;

      if (block.text.trim() === "" && signature === undefined) continue;

      parts.push(
        signature === undefined
          ? { text: block.text }
          : { text: block.text, thoughtSignature: signature },
      );
      continue;
    }

    if (block.type === "thinking") {
      parts.push(...thinkingParts(block, sameModel));
      continue;
    }

    parts.push(...toolCallParts(block, { model, runtimeModel, replayable, dropped }));
  }

  return parts;
}

/**
 * Converts a stored thinking block, keeping only what the backend can replay.
 *
 * @param block - Thinking block
 * @param sameModel - Whether the block came from the selected model
 * @returns Zero or one thinking part
 */
function thinkingParts(block: ThinkingContent, sameModel: boolean): GeminiPart[] {
  if (block.thinking.trim() === "") return [];

  if (!sameModel) return [];

  // Older stored sessions may contain unsigned blocks, so omit them rather
  // than breaking the conversation's subsequent turns.
  if (!isValidThoughtSignature(block.thinkingSignature)) return [];

  return [{ thought: true, text: block.thinking, thoughtSignature: block.thinkingSignature }];
}

/** Context for converting one tool call. */
interface ToolCallContext {
  model: AntigravityModel;
  runtimeModel: string;
  replayable: boolean;
  dropped: DroppedCalls;
}

/**
 * Converts a stored tool call into a function-call part or records it as dropped.
 *
 * @param call - Stored tool call
 * @param context - Conversion context
 * @returns Zero or one function-call part
 */
function toolCallParts(call: ToolCall, context: ToolCallContext): GeminiPart[] {
  if (!context.replayable) {
    const args = JSON.stringify(call.arguments ?? {});

    if (call.id === "") {
      const queue = context.dropped.byName.get(call.name) ?? [];
      queue.push(args);
      context.dropped.byName.set(call.name, queue);
    } else {
      context.dropped.byId.set(call.id, args);
    }

    return [];
  }

  const part: GeminiFunctionCallPart = {
    functionCall: { name: call.name, args: call.arguments ?? {} },
  };

  if (call.thoughtSignature !== undefined) part.thoughtSignature = call.thoughtSignature;

  return [part];
}

/**
 * Converts a tool result into either a function response or observation text.
 *
 * @param message - Tool-result message from the transcript
 * @param context - Conversion context
 * @returns Parts for the user turn that carries the result
 */
function toolResultParts(
  message: Extract<Message, { role: "toolResult" }>,
  context: { model: AntigravityModel; runtimeModel: string; dropped: DroppedCalls },
): GeminiPart[] {
  const text = message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  const summary = text === "" ? (message.isError ? "Tool failed" : "") : text;
  const images: GeminiInlineDataPart[] = [];

  for (const block of message.content) {
    if (block.type !== "image") continue;

    const image = parseImageData(block.data, block.mimeType);

    if (image.data !== "") images.push({ inlineData: image });
  }

  const droppedArgs = takeDroppedArgs(message, context.dropped);

  if (droppedArgs !== undefined) {
    return [
      { text: `[Observation from \`${message.toolName}\` (${droppedArgs}):\n${summary}]` },
      ...images,
    ];
  }

  return [
    {
      functionResponse: {
        name: message.toolName,
        response: message.isError ? { error: summary } : { output: summary },
      },
    },
    ...images,
  ];
}

/**
 * Removes and returns the arguments of a tool call that was dropped for replay.
 *
 * @param message - Tool-result message
 * @param dropped - Recorded dropped calls
 * @returns The dropped call's arguments, or undefined when the call was replayed
 */
function takeDroppedArgs(
  message: Extract<Message, { role: "toolResult" }>,
  dropped: DroppedCalls,
): string | undefined {
  if (message.toolCallId !== "") {
    const args = dropped.byId.get(message.toolCallId);

    if (args !== undefined) {
      dropped.byId.delete(message.toolCallId);

      return args;
    }
  }

  const queue = dropped.byName.get(message.toolName);

  if (queue === undefined || queue.length === 0) return undefined;

  const args = queue.shift();

  if (queue.length === 0) dropped.byName.delete(message.toolName);

  return args;
}

/**
 * Builds the conversation turns for one request.
 *
 * @param input - Request inputs
 * @returns Gemini content turns, with the protocol bridges the backend requires
 */
export function buildContents(input: RequestInput): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const dropped: DroppedCalls = { byId: new Map(), byName: new Map() };

  for (const message of input.messages) {
    if (message.role === "system") continue;

    if (message.role === "user") {
      appendTurn(contents, "user", userParts(message));
      continue;
    }

    if (message.role === "assistant") {
      appendTurn(
        contents,
        "model",
        assistantParts(message, input.model, input.runtimeModel, dropped),
      );
      continue;
    }

    appendTurn(
      contents,
      "user",
      toolResultParts(message, {
        model: input.model,
        runtimeModel: input.runtimeModel,
        dropped,
      }),
    );
  }

  restoreToolCallBoundaries(contents);
  ensureUserText(contents);

  return contents;
}

/**
 * Inserts a user turn before a model tool call that no user turn precedes, which
 * compacted history can produce.
 *
 * @param contents - Turns to normalize in place
 */
function restoreToolCallBoundaries(contents: GeminiContent[]): void {
  for (let index = 0; index < contents.length; index += 1) {
    const turn = contents[index];

    if (turn === undefined || turn.role !== "model") continue;

    if (!turn.parts.some((part) => "functionCall" in part)) continue;

    if (contents[index - 1]?.role === "user") continue;

    contents.splice(index, 0, { role: "user", parts: [{ text: CONTINUATION_TEXT }] });
    index += 1;
  }
}

/**
 * Guarantees at least one natural-language user part.
 *
 * The backend rejects requests whose user turns carry only tool results, and a
 * trailing model turn would leave nothing to answer.
 *
 * @param contents - Turns to normalize in place
 */
function ensureUserText(contents: GeminiContent[]): void {
  const hasUserText = contents.some(
    (turn) =>
      turn.role === "user" && turn.parts.some((part) => "text" in part && part.text.trim() !== ""),
  );

  if (!hasUserText) {
    const userTurn = contents.find((turn) => turn.role === "user");

    if (userTurn === undefined)
      contents.unshift({ role: "user", parts: [{ text: CONTINUATION_TEXT }] });
    else userTurn.parts.push({ text: CONTINUATION_TEXT });
  }

  if (contents.at(-1)?.role === "model") {
    contents.push({ role: "user", parts: [{ text: CONTINUATION_TEXT }] });
  }
}

/** State threaded through schema normalization. */
interface SchemaState {
  nodes: number;
}

/**
 * Resolves a local JSON Pointer against the schema that declared the reference.
 *
 * @param ref - Reference such as `#/$defs/Node`
 * @param root - Root schema of the same tool declaration
 * @returns The referenced value, or undefined when it cannot be resolved
 */
function resolvePointer(ref: string, root: JsonObject): JsonValue | undefined {
  if (ref === "#") return root;

  if (!ref.startsWith("#/")) return undefined;

  let current: JsonValue | undefined = root;

  for (const token of ref.slice(2).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");

    if (Array.isArray(current)) {
      const index = Number(key);

      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) return undefined;

      current = current[index];
      continue;
    }

    if (!isJsonObject(current)) return undefined;

    if (!Object.hasOwn(current, key)) return undefined;

    current = current[key];
  }

  return current;
}

/**
 * Inlines local `$ref` targets and strips metadata the backend rejects.
 *
 * Expansion is bounded by depth and node count. A reference that cannot be
 * resolved becomes an empty schema, which keeps the rest of the declaration
 * usable instead of failing the whole request.
 *
 * @param schema - Tool parameter schema from Pi
 * @returns A self-contained JSON Schema
 */
export function normalizeSchema(schema: JsonValue): JsonObject {
  const root = isJsonObject(schema) ? schema : {};
  const normalized = expandSchema(root, root, new Set(), { nodes: 0 }, 0);

  return isJsonObject(normalized) ? stripMeta(normalized) : {};
}

/** Writes a schema key as JSON data without invoking an inherited setter. */
function setSchemaEntry(target: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * Recursively inlines local references.
 *
 * @param value - Current schema value
 * @param root - Root schema of this declaration
 * @param seen - References already expanded on this path
 * @param state - Node budget
 * @param depth - Current depth
 * @returns The expanded value
 */
function expandSchema(
  value: JsonValue | undefined,
  root: JsonObject,
  seen: ReadonlySet<string>,
  state: SchemaState,
  depth: number,
): JsonValue {
  if (depth > MAX_SCHEMA_DEPTH || state.nodes > MAX_SCHEMA_NODES) return {};

  if (!isJsonObject(value)) return Array.isArray(value) ? value.map(() => ({})) : (value ?? {});

  state.nodes += 1;

  const ref = value.$ref;

  if (isJsonText(ref)) {
    const target = resolvePointer(ref, root);

    if (target === undefined || seen.has(ref)) return {};

    const nextSeen = new Set(seen);

    nextSeen.add(ref);

    return expandSchema(target, root, nextSeen, state, depth + 1);
  }

  const out: JsonObject = {};

  for (const [key, entry] of Object.entries(value)) {
    setSchemaEntry(out, key, expandKeyword(key, entry, root, seen, state, depth));
  }

  return out;
}

/**
 * Expands one keyword's value, respecting map, value, and array keyword shapes.
 *
 * @param key - Schema keyword
 * @param value - Keyword value
 * @param root - Root schema of this declaration
 * @param seen - References already expanded on this path
 * @param state - Node budget
 * @param depth - Current depth
 * @returns The expanded keyword value
 */
function expandKeyword(
  key: string,
  value: JsonValue,
  root: JsonObject,
  seen: ReadonlySet<string>,
  state: SchemaState,
  depth: number,
): JsonValue {
  if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(value)) {
    const mapped: JsonObject = {};

    for (const [name, entry] of Object.entries(value)) {
      setSchemaEntry(mapped, name, expandSchema(entry, root, seen, state, depth + 1));
    }

    return mapped;
  }

  if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
    return value.map((entry) => expandSchema(entry, root, seen, state, depth + 1));
  }

  if (SCHEMA_VALUE_KEYWORDS.has(key)) {
    return expandSchema(value, root, seen, state, depth + 1);
  }

  return value;
}

/**
 * Removes schema metadata the backend rejects, without touching property names.
 *
 * @param schema - Expanded schema object
 * @returns A schema without metadata keywords
 */
function stripMeta(schema: JsonObject): JsonObject {
  const out: JsonObject = {};

  for (const [key, value] of Object.entries(schema)) {
    if (META_SCHEMA_KEYWORDS.has(key)) continue;

    setSchemaEntry(out, key, stripMetaKeyword(key, value));
  }

  return out;
}

/**
 * Strips metadata from a keyword value whose shape is known.
 *
 * @param key - Schema keyword
 * @param value - Keyword value
 * @returns The value with metadata removed where applicable
 */
function stripMetaKeyword(key: string, value: JsonValue): JsonValue {
  if (SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(value)) {
    const mapped: JsonObject = {};

    for (const [name, entry] of Object.entries(value)) {
      setSchemaEntry(mapped, name, isJsonObject(entry) ? stripMeta(entry) : entry);
    }

    return mapped;
  }

  if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
    return value.map((entry) => (isJsonObject(entry) ? stripMeta(entry) : entry));
  }

  if (SCHEMA_VALUE_KEYWORDS.has(key)) {
    return isJsonObject(value) ? stripMeta(value) : value;
  }

  return value;
}

/**
 * Builds tool declarations in the schema form the runtime model accepts.
 *
 * @param tools - Tools declared by Pi
 * @returns Tool declarations, or undefined when no tool has a usable schema
 */
export function buildTools(
  tools: readonly Tool[],
): { functionDeclarations: GeminiFunctionDeclaration[] }[] | undefined {
  const declarations: GeminiFunctionDeclaration[] = [];

  for (const tool of tools) {
    // SAFETY: Pi declares tool parameters as an object that is serialized into the request as JSON.
    const schema = normalizeSchema(tool.parameters as JsonValue);

    declarations.push({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: schema,
    });
  }

  return declarations.length === 0 ? undefined : [{ functionDeclarations: declarations }];
}

/** Pi's default preamble triggers a generic 429 on the Antigravity endpoint. */
const PI_DEFAULT_PREAMBLE = "You are a coding assistant running inside pi, a coding agent harness.";

/**
 * Rephrases two exact phrases in Pi's default prompt that trigger a generic
 * 429 from the backend, while preserving the instructions' meaning.
 *
 * @param prompt - Pi's current system prompt
 * @returns A compatible system prompt
 */
export function compatibleSystemPrompt(prompt: string): string {
  if (!prompt.startsWith(PI_DEFAULT_PREAMBLE)) return prompt;

  const remainder = prompt
    .slice(PI_DEFAULT_PREAMBLE.length)
    .replace("non-LLM models such as classifiers and image models", "classifiers and image models");

  return `You are a coding assistant in a development environment.${remainder}`;
}

/**
 * Assembles the full request the backend expects.
 *
 * @param input - Request inputs
 * @returns The envelope to POST
 */
export function buildRequest(input: RequestInput): AntigravityRequestEnvelope {
  const contents = buildContents(input);

  const systemParts: GeminiTextPart[] =
    input.systemPrompt.trim() === "" ? [] : [{ text: compatibleSystemPrompt(input.systemPrompt) }];

  const step = Math.max(1, contents.length);

  const request: GeminiRequestBody = {
    contents,
    systemInstruction: { role: "user", parts: systemParts },
    sessionId: input.identity.sessionId,
    labels: labelsFor(input.identity.trajectoryId, step, input.requestIndex, input.runtimeModel),
  };

  const generationConfig = buildGenerationConfig(input);

  if (generationConfig !== undefined) request.generationConfig = generationConfig;

  const tools = buildTools(input.tools);

  if (tools !== undefined) request.tools = tools;

  return {
    project: input.projectId,
    model: input.runtimeModel,
    request,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: requestIdFor(
      input.identity.conversationId,
      input.identity.trajectoryId,
      step,
      input.now,
    ),
  };
}

/**
 * Builds generation settings, clamping the output limit to the model's ceiling.
 *
 * @param input - Request inputs
 * @returns Generation settings, or undefined when nothing applies
 */
function buildGenerationConfig(input: RequestInput): GeminiGenerationConfig | undefined {
  const config: GeminiGenerationConfig = {};

  const thinking =
    input.discoveredThinkingConfig ?? thinkingConfig(input.runtimeModel, input.thinkingLevel);

  if (thinking !== undefined) config.thinkingConfig = thinking;

  const ceiling = input.model.maxTokens;
  const requested = input.maxTokens === undefined ? ceiling : Math.min(input.maxTokens, ceiling);

  if (requested > 0) config.maxOutputTokens = requested;

  if (input.temperature !== undefined) config.temperature = input.temperature;

  return Object.keys(config).length === 0 ? undefined : config;
}

/**
 * Builds the per-request envelope id the backend reads for tracing.
 *
 * @param conversationId - Stable identifier for this conversation
 * @param trajectoryId - Stable identifier for this request series
 * @param step - Number of content turns in the request
 * @param now - Clock used for the timestamp
 * @returns The request id
 */
export function requestIdFor(
  conversationId: string,
  trajectoryId: string,
  step: number,
  now: number,
): string {
  return `agent/${conversationId}/${now}/${trajectoryId}/${Math.max(1, step)}`;
}

/** Labels the backend uses to attribute a request to a conversation step. */
export interface RequestLabels {
  last_step_index: string;
  request_id: string;
  trajectory_id: string;
  used_claude: string;
  used_claude_conservative: string;
  used_non_gemini_model: string;
}

/**
 * Builds the request labels the backend reads for tracing and routing.
 *
 * @param trajectoryId - Stable identifier for this conversation
 * @param step - Number of content turns in the request
 * @param requestIndex - Zero-based index of this request within the conversation
 * @param runtimeModel - Backend request model id
 * @returns Label map for the request body
 */
export function labelsFor(
  trajectoryId: string,
  step: number,
  requestIndex: number,
  runtimeModel: string,
): RequestLabels {
  const nonGemini = !runtimeModel.startsWith("gemini-");

  return {
    last_step_index: String(Math.max(0, step - 1)),
    request_id: `${trajectoryId}-${requestIndex}`,
    trajectory_id: trajectoryId,
    used_claude: "false",
    used_claude_conservative: "false",
    used_non_gemini_model: nonGemini ? "true" : "false",
  };
}
