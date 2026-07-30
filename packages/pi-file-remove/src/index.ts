import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FILE_REMOVE_GUIDANCE = `## File removal

- Use \`gomi\` instead of \`rm\` on the user's local development machine.
- In CI, containers, or production, use the existing removal workflow.`;

/** Prefer recoverable file removal during personal local development. */
export default function fileRemove(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    if (!event.systemPromptOptions.selectedTools?.includes("bash")) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${FILE_REMOVE_GUIDANCE}`,
    };
  });
}
