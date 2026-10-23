import { READ_TOOL } from "./fingerprint.ts";

interface ToolFunctionReference {
  name?: string;
  description?: string;
}

interface ToolDeclaration {
  type?: string;
  function?: ToolFunctionReference;
}

interface ToolChoiceObject {
  type?: string;
}

/** The subset of an OpenAI chat-completions payload the extension needs to inspect. */
export interface ProviderRequestPayload {
  model?: string;
  stream?: boolean;
  tools?: readonly ToolDeclaration[];
  tool_choice?: string | ToolChoiceObject;
  temperature?: number;
  max_tokens?: number;
}

/**
 * Validates the subset of a provider request payload used for normalization.
 *
 * Other payload fields are intentionally ignored and survive reconstruction.
 *
 * @param value - Candidate provider request payload
 * @returns Whether the payload has the shape needed for free-tier normalization
 */
export function isProviderRequestPayload(value: unknown): value is ProviderRequestPayload {
  if (value === null || typeof value !== "object" || !("model" in value)) return false;

  if (typeof value.model !== "string") return false;

  if ("stream" in value && value.stream !== undefined && typeof value.stream !== "boolean") {
    return false;
  }

  if ("tools" in value && value.tools !== undefined) {
    if (!Array.isArray(value.tools)) return false;

    for (const tool of value.tools) {
      if (!isToolDeclaration(tool)) return false;
    }
  }

  if ("tool_choice" in value && value.tool_choice !== undefined) {
    if (!isToolChoice(value.tool_choice)) return false;
  }

  return true;
}

/**
 * Applies the free-tier request contract to a provider payload.
 *
 * The request must stream and must declare a tool named exactly `read`.
 * Both `tool_choice: "none"` and `tool_choice: { type: "none" }` are removed
 * because the gate rejects them, while every other field and tool declaration
 * is preserved. The original payload is not mutated.
 *
 * @param payload - Validated provider request payload
 * @returns A normalized copy suitable for the free-tier endpoint
 */
export function normalizeFreeRequestPayload(
  payload: ProviderRequestPayload,
): ProviderRequestPayload {
  const tools = appendReadTool(payload.tools);

  const normalized: ProviderRequestPayload = {
    ...payload,
    stream: true,
  };

  if (tools !== payload.tools) normalized.tools = tools;

  if (isNoneToolChoice(payload.tool_choice)) delete normalized.tool_choice;

  return normalized;
}

/** Reuses tools containing an exact `read` name, or returns a new list with the default appended. */
function appendReadTool(tools: readonly ToolDeclaration[] | undefined): readonly ToolDeclaration[] {
  if (!tools) return [READ_TOOL];

  for (const tool of tools) {
    if (tool.function?.name === "read") return tools;
  }

  return [...tools, READ_TOOL];
}

/** Recognizes both the string and object forms of the rejected `none` tool choice. */
function isNoneToolChoice(value: unknown): value is "none" | ToolChoiceObject {
  if (value === "none") return true;

  return value !== null && typeof value === "object" && "type" in value && value.type === "none";
}

/** Accepts any string or non-null object without validating a particular tool-choice schema. */
function isToolChoice(value: unknown): value is string | ToolChoiceObject {
  if (typeof value === "string") return true;

  return value !== null && typeof value === "object";
}

/** Requires a function object with a string name; other declaration fields are not validated. */
function isToolDeclaration(value: unknown): value is ToolDeclaration {
  if (value === null || typeof value !== "object" || !("function" in value)) return false;

  const fn = value.function;

  if (fn === null || typeof fn !== "object" || !("name" in fn)) return false;

  return typeof fn.name === "string";
}
