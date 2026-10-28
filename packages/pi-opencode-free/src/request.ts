interface ToolFunctionReference {
  name?: string;
  description?: string;
  parameters?: object;
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

  if ("messages" in value && value.messages !== undefined && !Array.isArray(value.messages)) {
    return false;
  }

  if ("tool_choice" in value && value.tool_choice !== undefined) {
    if (!isToolChoice(value.tool_choice)) return false;
  }

  return true;
}

/** Apply only the gateway's observed streaming, environment and tool requirements. */
export function normalizeFreeRequestPayload(
  payload: ProviderRequestPayload,
): ProviderRequestPayload {
  const normalized = { ...payload, stream: true };

  if (isNoneToolChoice(payload.tool_choice)) delete normalized.tool_choice;

  if (!payload.tools?.length)
    normalized.tools = [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ];
  const messages = payload.messages;

  if (messages) {
    const instructions = messages.filter(
      (message) => message.role === "system" || message.role === "developer",
    );

    const hasEnv = instructions.some((message) =>
      /<env>(?:(?!<\/env>)[^])*?\bWorking directory:(?:(?!<\/env>)[^])*?<\/env>/u.test(
        Array.isArray(message.content)
          ? message.content.map((part) => textPart(part)).join("")
          : (message.content ?? ""),
      ),
    );

    if (!hasEnv) {
      const block = `<env>\n Working directory: ${process.cwd().replaceAll(/[\r\n<>]+/gu, " ")}\n</env>`;

      const index = messages.findIndex(
        (message) => message.role === "system" || message.role === "developer",
      );

      if (index < 0) normalized.messages = [{ role: "system", content: block }, ...messages];
      else
        normalized.messages = messages.map((message, i) =>
          i !== index
            ? message
            : {
                ...message,
                content: Array.isArray(message.content)
                  ? [{ type: "text", text: block }, ...message.content]
                  : `${block}\n\n${message.content ?? ""}`,
              },
        );
    }
  }

  return normalized;
}

/** Extract text from an untrusted structured message part. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- structured content is supplied by callers.
function textPart(part: unknown): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- inspect untrusted content parts.
  if (part && typeof part === "object" && "text" in part && typeof part.text === "string")
    return part.text;

  return "";
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
