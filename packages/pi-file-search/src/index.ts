import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FILE_SEARCH_GUIDANCE = `## File search

- Use \`fd\` for file and directory searches.`;

const FIND_INVOCATION =
  /(?:^|[\n;&|({])\s*(?:(?:command|exec|sudo)\s+(?:-[^\s]+\s+)*)*(?:find|\/(?:[^\s/;&|()]+\/)*find)(?=\s|$)/;
/** Detect common direct find invocations. This is an enforcement guard, not a shell sandbox. */
export function containsFindInvocation(command: string): boolean {
  return FIND_INVOCATION.test(command.replaceAll(/\\\r?\n/g, " "));
}

/** Prefer fd and gate find-based filesystem searches. */
export default function fileSearch(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    if (
      !event.systemPromptOptions.selectedTools?.includes("bash") ||
      event.systemPrompt.includes(FILE_SEARCH_GUIDANCE)
    ) {
      return;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${FILE_SEARCH_GUIDANCE}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const command =
      isToolCallEventType("bash", event) && containsFindInvocation(event.input.command)
        ? event.input.command
        : undefined;
    if (event.toolName !== "find" && command === undefined) return;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: "find blocked without user confirmation. Use fd instead.",
      };
    }

    const allowed = await ctx.ui.confirm(
      "Alternative file search",
      command ? `Allow this command?\n\n${command}` : "Allow the find tool call?",
    );

    if (!allowed) {
      return { block: true, reason: "find was not approved." };
    }
  });
}
