import { READ_TOOL } from "./client-headers.ts";

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

/** A chat message; only the role and the textual content are inspected. */
interface ChatMessageReference {
  role?: string;
  content?: string | unknown[];
}

/** The subset of an OpenAI chat-completions payload the extension needs to inspect. */
export interface ProviderRequestPayload {
  model?: string;
  stream?: boolean;
  tools?: readonly ToolDeclaration[];
  tool_choice?: string | ToolChoiceObject;
  temperature?: number;
  max_tokens?: number;
  messages?: readonly ChatMessageReference[];
}

/** Roles that carry request-level instructions. */
const SYSTEM_ROLES = new Set(["system", "developer"]);

/** Recognizes a declared working directory, which the gateway requires inside an env block. */
const WORKING_DIRECTORY_PATTERN = /<env>[\s\S]*?\bWorking directory:/u;

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
 * The request must stream, must declare a tool named exactly `read`, and must
 * carry an env block declaring a working directory. Both `tool_choice: "none"`
 * and `tool_choice: { type: "none" }` are removed because the gateway rejects
 * them, while every other field and tool declaration is preserved. The original
 * payload is not mutated.
 *
 * The gateway requires a working directory declaration and accepts any path,
 * while a prompt without the block is refused. Pi writes its own `<cwd>` element,
 * so the block is appended instead of being copied from another client's prompt.
 *
 * @param payload - Validated provider request payload
 * @param workingDirectory - Absolute path declared to the gateway, defaulting to the process directory
 * @returns A normalized copy suitable for the free-tier endpoint
 */
export function normalizeFreeRequestPayload(
  payload: ProviderRequestPayload,
  workingDirectory: string = process.cwd(),
): ProviderRequestPayload {
  const tools = appendReadTool(payload.tools);

  const normalized: ProviderRequestPayload = {
    ...payload,
    stream: true,
  };

  if (tools !== payload.tools) normalized.tools = tools;

  if (isNoneToolChoice(payload.tool_choice)) delete normalized.tool_choice;

  const messages = withWorkingDirectory(payload.messages, workingDirectory);

  if (messages !== payload.messages) normalized.messages = messages;

  return normalized;
}

/**
 * Ensures the request declares its working directory inside an env block.
 *
 * Reuses an existing block so repeated normalization stays idempotent, appends
 * to the last instruction message when the payload has one, and otherwise
 * prepends a message of its own.
 *
 * @param messages - Request messages, if the caller supplied any
 * @param workingDirectory - Path to declare
 * @returns The original array when no change is needed, otherwise a new array
 */
function withWorkingDirectory(
  messages: readonly ChatMessageReference[] | undefined,
  workingDirectory: string,
): readonly ChatMessageReference[] | undefined {
  if (!messages) return messages;

  const block = `<env>\n  Working directory: ${sanitizePath(workingDirectory)}\n</env>\n`;
  const index = lastInstructionIndex(messages);
  const target = index >= 0 ? messages[index] : undefined;

  if (target && WORKING_DIRECTORY_PATTERN.test(messageText(target.content))) return messages;

  if (!target) return [{ role: "system", content: block }, ...messages];

  const content = Array.isArray(target.content)
    ? [...target.content, { type: "text", text: block }]
    : `${target.content ?? ""}\n\n${block}`;

  return messages.map((message, position) =>
    position === index ? { ...message, content } : message,
  );
}

/** Flattens the textual parts of a message so a multiline prompt can be inspected. */
function messageText(content: ChatMessageReference["content"]): string {
  if (Array.isArray(content)) {
    return content.map((part) => (isTextPart(part) ? part.text : "")).join("");
  }

  return content ?? "";
}

/** Finds the final message carrying request-level instructions. */
function lastInstructionIndex(messages: readonly ChatMessageReference[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messages[index]?.role;

    if (role !== undefined && SYSTEM_ROLES.has(role)) return index;
  }

  return -1;
}

/** Narrows a structured content part that carries text. */
function isTextPart(value: unknown): value is { text: string } {
  return (
    typeof value === "object" && value !== null && "text" in value && typeof value.text === "string"
  );
}

/** Keeps a declared path on one line and prevents it from closing the block early. */
function sanitizePath(workingDirectory: string): string {
  return workingDirectory.replaceAll(/[\r\n<>]+/gu, " ");
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
