import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const VITE_PLUS_GUIDANCE = `## Vite+

- Use \`vp\` for package management and development workflows.`;

const PACKAGE_MANAGER_INVOCATION =
  /(?:^|[\n;&|({])\s*(?:(?:command|exec|sudo)\s+(?:-[^\s]+\s+)*)*(?:npm|npx|pnpm|pnpx|bun|bunx|\/(?:[^\s/;&|()]+\/)*(?:npm|npx|pnpm|pnpx|bun|bunx))(?=\s|$)/;

/** Detect direct npm, pnpm, and Bun invocations that should run through Vite+. */
export function containsPackageManagerInvocation(command: string): boolean {
  return PACKAGE_MANAGER_INVOCATION.test(command.replaceAll(/\\\r?\n/g, " "));
}

/** Prefer Vite+ workflows and gate selected package-manager commands. */
export default function vitePlus(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    if (
      !event.systemPromptOptions.selectedTools?.includes("bash") ||
      event.systemPrompt.includes(VITE_PLUS_GUIDANCE)
    ) {
      return;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${VITE_PLUS_GUIDANCE}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (
      !isToolCallEventType("bash", event) ||
      !containsPackageManagerInvocation(event.input.command)
    ) {
      return;
    }

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: "Package-manager command blocked without user confirmation. Use vp instead.",
      };
    }

    const allowed = await ctx.ui.confirm(
      "Direct package-manager command",
      `Allow this command?\n\n${event.input.command}`,
    );

    if (!allowed) {
      return { block: true, reason: "Package-manager command was not approved." };
    }
  });
}
