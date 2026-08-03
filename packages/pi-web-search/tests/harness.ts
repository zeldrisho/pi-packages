import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, vi } from "vite-plus/test";
import registerWebSearch from "../src/index";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, keyHint: () => "Ctrl+O to expand" };
});

export interface SearchParameters {
  query: string;
  count?: number;
  freshness?: "day" | "week" | "month" | "year";
  mode?: "web" | "context";
  language?: string;
}

export interface SearchExecutionResult {
  content: Array<{ type: "text"; text: string }>;
  details: {
    cached: boolean;
    mode: "web" | "context";
    resultCount: number;
    results: Array<{ title: string; url: string; snippet: string }>;
    truncated: boolean;
    fullOutputPath?: string;
    truncation: {
      truncated: boolean;
      strategy: "temporary-file" | "none";
      fullOutputPath?: string;
      outputBytes: number;
      totalBytes: number;
      outputLines: number;
      totalLines: number;
    };
  };
}

export interface RenderedComponent {
  render(width: number): string[];
}

export interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface SearchTool {
  renderCall(args: { query: string }, theme: RenderTheme): RenderedComponent;
  execute(
    toolCallId: string,
    params: SearchParameters,
    signal: AbortSignal | undefined,
    onUpdate:
      | ((update: { content: Array<{ type: "text"; text: string }>; details: object }) => void)
      | undefined,
  ): Promise<SearchExecutionResult>;
  renderResult(
    result: SearchExecutionResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: RenderTheme,
  ): RenderedComponent;
}

export type ShutdownHandler = () => Promise<void> | void;

/**
 * Registers the web-search extension and captures its tool and session shutdown handler.
 *
 * @returns The registered search tool and a getter for the session shutdown handler.
 */
export function createSearchHarness(): {
  tool: SearchTool;
  getShutdownHandler: () => ShutdownHandler | undefined;
} {
  let registered: unknown;
  let shutdownHandler: ShutdownHandler | undefined;
  registerWebSearch({
    registerTool(tool: unknown) {
      registered = tool;
    },
    on(event: string, handler: ShutdownHandler) {
      if (event === "session_shutdown") shutdownHandler = handler;
    },
  } as unknown as ExtensionAPI);
  if (!registered) throw new Error("web_search was not registered");
  return {
    tool: registered as SearchTool,
    getShutdownHandler: () => shutdownHandler,
  };
}

/**
 * Creates a registered web-search tool for testing.
 *
 * @returns The registered search tool
 */
export function createSearchTool(): SearchTool {
  return createSearchHarness().tool;
}

/**
 * Creates an HTTP response containing a JSON-encoded value.
 *
 * @param value - The value to serialize as JSON
 * @param status - The HTTP status code for the response
 * @returns A response with a JSON body and content type
 */
export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const renderTheme: RenderTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

const originalApiKey = process.env.BRAVE_SEARCH_API_KEY;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = originalApiKey;
});
