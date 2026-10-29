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
    const hasEnv = messages.some(
      (message) => isInstructionMessage(message) && ENV_BLOCK.test(messageText(message.content)),
    );

    if (!hasEnv) normalized.messages = replaceEnvironment(messages);
  }

  return normalized;
}

/** A structured prompt part; only the textual fields are read. */
interface ContentPartReference {
  type?: string;
  text?: string;
}

/** Matches Pi's harness `<cwd>` block and captures the path it declares. */
const CWD_BLOCK = /<cwd>([^]*?)<\/cwd>/u;

/** Matches the gateway's environment block when it already declares a working directory. */
const ENV_BLOCK = /<env>(?:(?!<\/env>)[^])*?\bWorking directory:(?:(?!<\/env>)[^])*?<\/env>/u;

/** Returns whether a message carries prompt instructions for the gateway. */
function isInstructionMessage(message: ChatMessageReference): boolean {
  return message.role === "system" || message.role === "developer";
}

/** Joins the textual parts of a message content value. */
function messageText(content: ChatMessageReference["content"]): string {
  return Array.isArray(content) ? content.map((part) => textPart(part)).join("") : (content ?? "");
}

/** Flattens path separators that would end the environment block early. */
function sanitizePath(path: string): string {
  return path.replaceAll(/[\r\n<>]+/gu, " ").trim();
}

/** Formats the gateway's required environment block for a working directory. */
function envBlock(path: string): string {
  const directory = sanitizePath(path) || sanitizePath(process.cwd());

  return `<env>\n Working directory: ${directory}\n</env>`;
}

/** Result of converting Pi's `<cwd>` block within a single message. */
interface CwdBlockConversion {
  content: string | unknown[];
  converted: boolean;
}

/**
 * Replaces Pi's `<cwd>` block with the gateway's environment block.
 *
 * @param content - String or structured message content
 * @returns The possibly updated content and whether a block was converted
 */
function convertCwdBlock(content: ChatMessageReference["content"]): CwdBlockConversion {
  if (Array.isArray(content)) {
    for (const [index, part] of content.entries()) {
      const text = textPart(part);

      if (!CWD_BLOCK.test(text)) continue;

      const parts = [...content];

      // SAFETY: textPart returned this part's text, so it declares a string text field.
      const source = part as ContentPartReference;

      parts[index] = {
        ...source,
        text: text.replace(CWD_BLOCK, (_match, path: string) => envBlock(path)),
      };

      return { content: parts, converted: true };
    }

    return { content, converted: false };
  }

  const text = content ?? "";

  if (!CWD_BLOCK.test(text)) return { content: text, converted: false };

  return {
    content: text.replace(CWD_BLOCK, (_match, path: string) => envBlock(path)),
    converted: true,
  };
}

/** Prepends a prompt block, keeping structured content intact. */
function prependBlock(content: ChatMessageReference["content"], block: string): string | unknown[] {
  return Array.isArray(content)
    ? [{ type: "text", text: block }, ...content]
    : `${block}\n\n${content ?? ""}`;
}

/**
 * Resolves the gateway environment block without mutating the caller's messages.
 *
 * The first instruction message carrying Pi's `<cwd>` block has that block
 * replaced, so the request keeps one working directory. Without a `<cwd>`
 * block the environment block is prepended to the first instruction message,
 * creating one when no instruction message exists.
 *
 * @param messages - Provider messages to copy when a block is written
 * @returns New messages when converted, otherwise the original messages
 */
function replaceEnvironment(
  messages: readonly ChatMessageReference[],
): readonly ChatMessageReference[] {
  let converted = false;

  const updated = messages.map((message) => {
    if (converted || !isInstructionMessage(message)) return message;

    const result = convertCwdBlock(message.content);

    if (!result.converted) return message;

    converted = true;

    return { ...message, content: result.content };
  });

  if (converted) return updated;

  const block = envBlock(process.cwd());
  const index = messages.findIndex(isInstructionMessage);

  if (index < 0) return [{ role: "system", content: block }, ...messages];

  return updated.map((message, i) =>
    i === index ? { ...message, content: prependBlock(message.content, block) } : message,
  );
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
