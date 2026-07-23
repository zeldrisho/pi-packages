import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FILE_REMOVE_GUIDANCE = `## File removal

- Use \`gomi\` to move files and directories to recoverable trash.`;

const RM_INVOCATION =
  /(?:^|[\n;&|({])\s*(?:(?:command|exec|sudo)\s+(?:-[^\s]+\s+)*)*(?:rm|\/(?:[^\s/;&|()]+\/)*rm)(?=\s|$)/;

/** Detect common direct rm invocations. This is a safety guard, not a shell sandbox. */
export function containsRmInvocation(command: string): boolean {
  return RM_INVOCATION.test(command.replaceAll(/\\\r?\n/g, " "));
}

/** Prefer recoverable file removal with gomi and gate permanent deletion. */
export default function fileRemove(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    if (
      !event.systemPromptOptions.selectedTools?.includes("bash") ||
      event.systemPrompt.includes(FILE_REMOVE_GUIDANCE)
    ) {
      return;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${FILE_REMOVE_GUIDANCE}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event) || !containsRmInvocation(event.input.command)) return;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: "Permanent deletion blocked without user confirmation. Use gomi instead.",
      };
    }

    const allowed = await ctx.ui.confirm(
      "Permanent deletion",
      `Allow this command?\n\n${event.input.command}`,
    );

    if (!allowed) {
      return { block: true, reason: "Permanent deletion was not approved." };
    }
  });
}
