import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FILE_SEARCH_GUIDANCE = `## File search

- Use \`fd\` via \`bash\` for file and directory searches.`;

/** Prefer fd for filesystem searches when the shell tool is available. */
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
}
