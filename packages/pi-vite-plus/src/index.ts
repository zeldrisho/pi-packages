import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const VITE_PLUS_GUIDANCE = `## Vite+

- Use \`vp\` for package management and development workflows.
- Use \`vp help\` or local docs in \`node_modules/vite-plus/docs\` when needed.`;

/** Prefer Vite+ for development workflows when shell commands are available. */
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
}
