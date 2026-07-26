import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FILE_REMOVE_GUIDANCE = `## File removal

- On the user's local development machine: use \`gomi\`, not \`rm\`.
- In CI, containers, or production: use the existing removal workflow.
- Use \`rm\` only for user-approved permanent deletion.`;

/** Prefer recoverable file removal during personal local development. */
export default function fileRemove(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    if (!event.systemPromptOptions.selectedTools?.includes("bash")) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${FILE_REMOVE_GUIDANCE}`,
    };
  });
}
