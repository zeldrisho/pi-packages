import { uuidv7 } from "@earendil-works/pi-ai";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import {
  convertToLlm,
  prepareBranchEntries,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { isStringArray } from "./values.ts";

type AgentMessage = Parameters<typeof convertToLlm>[0][number];

/** Mirrors Pi's own headroom constant for summarization requests. */
const WINDOW_SAFETY_TOKENS = 4_096;

/** Pi's default reserve, used when the preparation carries no compaction settings. */
const DEFAULT_RESERVE_TOKENS = 16_384;

/** Share of the model window one summarization request may use, whatever the model. */
const REQUEST_INPUT_SHARE = 0.12;

/** Bounds for the derived request budget, so small and large windows both stay usable. */
const MIN_REQUEST_INPUT_TOKENS = 4_000;

const MAX_REQUEST_INPUT_TOKENS = 60_000;

/** How often a truncated segment may be halved before its partial digest is accepted. */
const MAX_SPLIT_DEPTH = 3;

const STATUS_KEY = "opencode-free-compaction";

const BRANCH_STATUS_KEY = "opencode-free-branch-summary";

/** Sections of Pi's compaction format; a checkpoint missing one cannot replace a conversation. */
const CHECKPOINT_SECTIONS = ["## Goal", "## Progress", "## Next Steps", "## Critical Context"];

/** Sections of Pi's branch-summary format, which has no critical-context section. */
const BRANCH_SECTIONS = ["## Goal", "## Progress", "## Next Steps"];

/** Follow-up sent when a summary ignores the template instead of failing the whole attempt. */
const CHECKPOINT_NUDGE =
  "The previous response did not fill in the required checkpoint template. Do not call tools. Return the checkpoint as text using the exact section headings from the template.";

const SEGMENT_SYSTEM_PROMPT =
  "You are a conversation summarization assistant. You read one segment of a longer conversation and write a dense factual digest of it. Do NOT continue the conversation, answer questions, or invent details.";

const MERGE_SYSTEM_PROMPT =
  "You are a conversation summarization assistant. You merge digests of consecutive conversation segments into one structured checkpoint. Do NOT continue the conversation or invent details.";

/**
 * Text owned by Pi that this module reproduces verbatim.
 *
 * Pi exports neither its summarization prompts nor its file-list helpers, so the text is
 * copied here and compared with the installed package by `tests/pi-prompts.test.ts`, which
 * fails when an upgrade rewords it. Everything structural is imported and type-checked.
 */
export const PI_SUMMARY_TEXT = {
  turnPrefixPrompt: `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`,
  /** Heading Pi uses when it splices a turn prefix summary into a checkpoint. */
  turnPrefixMarker: "**Turn Context (split turn):**",
  /** Pi's summarization system prompt, used for the checkpoint request. */
  systemPrompt: `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`,
  /** Pi's initial checkpoint instructions, used when no previous checkpoint exists. */
  initialInstructions: `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`,
  /** Pi's update instructions, used when the checkpoint replaces an earlier one. */
  updateInstructions: `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`,
  /** Tags Pi appends to a checkpoint to list the files the conversation touched. */
  readFilesTag: "<read-files>",
  modifiedFilesTag: "<modified-files>",
  /** Pi's branch-summary instructions, used when the user summarizes a branch in `/tree`. */
  branchInstructions: `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`,
  /** Pi's preamble, placed before a branch summary to explain where it came from. */
  branchPreamble: `The user explored a different conversation branch before returning here.
Summary of that exploration:

`,
} as const;

/** Model facts used to size compaction requests. */
export interface CompactionModel {
  provider: string;
  contextWindow?: number;
  maxTokens?: number;
}

/** One completion issued while compacting. */
export interface CompactionRequest {
  systemPrompt: string;
  prompt: string;
  signal: AbortSignal;
}

/** Outcome of one compaction completion. */
export interface CompactionResponse {
  text: string;
  usage: Usage;
  stopReason: AssistantMessage["stopReason"];
  errorMessage?: string;
  /** True when the answer tried to call a tool instead of writing a summary. */
  hasToolCalls?: boolean;
}

/**
 * Context slice used by segmented compaction.
 *
 * The handler can read the model and run completions, but has no way to select,
 * switch, or re-register a model: the adapter captures the session model once.
 */
export interface CompactionContext {
  model: CompactionModel | undefined;
  complete(request: CompactionRequest): Promise<CompactionResponse>;
  notify(message: string, type: "info" | "warning"): void;
  setStatus(text: string | undefined): void;
}

/** File operations Pi extracts from the messages being summarized. */
export interface CompactionFileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

/** Preparation slice used by segmented compaction. */
export interface CompactionPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  tokensBefore: number;
  previousSummary?: string;
  fileOps: CompactionFileOperations;
  /** Compaction settings Pi resolved for this session. */
  settings?: { reserveTokens?: number };
}

/** Branch entry slice used to carry cumulative file lists forward. */
export interface CompactionBranchEntry {
  type: string;
  details?: unknown;
}

/** Event slice used by segmented compaction. */
export interface CompactionEvent {
  preparation: CompactionPreparation;
  branchEntries: readonly CompactionBranchEntry[];
  customInstructions?: string;
  reason: string;
  signal: AbortSignal;
}

/** Cumulative file lists stored on compaction entries. */
interface FileListsDetails {
  readFiles?: string[];
  modifiedFiles?: string[];
}

/** Preparation slice Pi hands to `session_before_tree`. */
export interface BranchPreparation {
  entriesToSummarize: SessionEntry[];
  userWantsSummary: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
}

/** Event slice used by segmented branch summarization. */
export interface BranchEvent {
  preparation: BranchPreparation;
  signal: AbortSignal;
}

/** Summary an extension supplies for the branch the user is leaving. */
export interface BranchResult {
  cancel?: boolean;
  summary?: {
    summary: string;
    details?: FileListsDetails;
    usage?: Usage;
  };
}

/** Injectable dependencies for tests and the default registration. */
export interface ChunkedCompactionDependencies {
  /** Routing identifier for one-off summary requests; defaults to a random UUID. */
  createSessionId?: () => string;
}

interface ModelResult {
  text: string;
  usage: Usage;
  /** True when the provider stopped at the token cap instead of finishing the answer. */
  truncated: boolean;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(total: Usage, next: Usage | undefined): Usage {
  if (!next) return total;

  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    totalTokens: total.totalTokens + next.totalTokens,
    reasoning:
      total.reasoning === undefined && next.reasoning === undefined
        ? undefined
        : (total.reasoning ?? 0) + (next.reasoning ?? 0),
    cost: {
      input: total.cost.input + next.cost.input,
      output: total.cost.output + next.cost.output,
      cacheRead: total.cost.cacheRead + next.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite + next.cost.cacheWrite,
      total: total.cost.total + next.cost.total,
    },
  };
}

function textTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Tokens Pi's native summary request adds beside the conversation: the previous
 * checkpoint, the instructions, and its system prompt. Deferring on the conversation
 * alone would leave Pi less output room than the estimate promises.
 */
function promptOverheadTokens(...parts: Array<string | undefined>): number {
  return textTokens(parts.filter((part): part is string => Boolean(part)).join("\n"));
}

function serialize(messages: AgentMessage[]): string {
  return serializeConversation(convertToLlm(messages));
}

/**
 * Runs one clamped completion through the supplied context.
 *
 * `reasoning` is never part of the request, so the clamped output allowance is
 * spent on the digest instead of on thinking tokens.
 */
async function callModel(
  context: CompactionContext,
  model: CompactionModel,
  systemPrompt: string,
  prompt: string,
  signal: AbortSignal,
): Promise<ModelResult> {
  // Pi leaves the answer cap to its provider layer: `clampMaxTokensToContext` fits the
  // model's own output limit to the room the prompt leaves in the window.
  const response = await context.complete({ systemPrompt, prompt, signal });

  if (response.stopReason === "aborted") {
    throw new Error("Summarization aborted");
  }

  if (response.stopReason === "error") {
    throw new Error(response.errorMessage || "Summarization request failed");
  }

  if (response.hasToolCalls) {
    throw new Error("Summarization attempted to call a tool");
  }

  return {
    text: response.text.trim(),
    usage: response.usage,
    truncated: response.stopReason === "length",
  };
}

/** Derives the serialized input one summarization request may carry from the model window. */
function requestInputBudget(contextWindow: number): number {
  return Math.min(
    MAX_REQUEST_INPUT_TOKENS,
    Math.max(MIN_REQUEST_INPUT_TOKENS, Math.round(contextWindow * REQUEST_INPUT_SHARE)),
  );
}

/** Splits messages at message boundaries so each segment's serialized form fits the budget. */
function segmentMessages(messages: AgentMessage[], budgetTokens: number): AgentMessage[][] {
  const segments: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = textTokens(serialize([message]));

    if (current.length > 0 && currentTokens + messageTokens > budgetTokens) {
      segments.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(message);
    currentTokens += messageTokens;
  }

  if (current.length > 0) segments.push(current);

  return segments;
}

/** Groups items into batches that fit the budget, avoiding a single-item batch at the end. */
function batchByBudget(items: string[], budgetTokens: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const item of items) {
    const itemTokens = textTokens(item);

    if (current.length > 0 && currentTokens + itemTokens > budgetTokens) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(item);
    currentTokens += itemTokens;
  }

  if (current.length > 0) batches.push(current);

  if (batches.length > 1 && batches[batches.length - 1].length === 1) {
    const last = batches.pop();

    if (last) batches[batches.length - 1].push(...last);
  }

  return batches;
}

function segmentPrompt(conversation: string, label: string): string {
  return `<conversation>\n${conversation}\n</conversation>

The conversation above is ${label} of a longer session. Other segments are summarized separately and merged later.

Write a dense digest of THIS segment only. Preserve, as short bullet points:
- what the user asked for and any constraints or preferences they stated
- decisions taken and their rationale
- exact file paths, identifiers, commands, and error messages that matter
- what each tool run produced and whether it worked
- state of the work at the end of the segment (done, in progress, blocked)

Drop pleasantries, duplicated tool output, and step-by-step narration. Stay under 400 words. Do not continue the conversation.`;
}

/** Builds the prompt for a split turn's prefix, as Pi does for turn prefix summaries. */
function turnPrefixPrompt(customInstructions: string | undefined): PromptBuilder {
  const focus = customInstructions ? `\n\nAdditional focus: ${customInstructions}` : "";

  return (conversation) =>
    `# Conversation\n${conversation}\n\n# Instructions\n${PI_SUMMARY_TEXT.turnPrefixPrompt}${focus}`;
}

/** Builds the prompt for one block of messages, given its serialized form. */
type PromptBuilder = (conversation: string, label: string) => string;

/** Trims a conversation a single message pushed past the budget, keeping both ends. */
function truncateConversation(conversation: string, budgetTokens: number): string {
  const maxChars = budgetTokens * 4;
  const head = Math.floor(maxChars / 2);
  const tail = maxChars - head;

  return `${conversation.slice(0, head)}\n\n[truncated to fit the summary budget]\n\n${conversation.slice(-tail)}`;
}

/** Summarizes one block of messages, halving it when the answer hits the token cap. */
async function summarizeMessages(
  context: CompactionContext,
  model: CompactionModel,
  messages: AgentMessage[],
  buildPrompt: PromptBuilder,
  label: string,
  signal: AbortSignal,
  budgetTokens: number,
  depth: number,
  usage: Usage,
): Promise<{ text: string; usage: Usage }> {
  // A single message can exceed the budget; halving cannot help one message, so trim it
  // explicitly instead of sending a prompt that leaves the digest too little output room.
  const conversation = serialize(messages);

  const bounded =
    textTokens(conversation) > budgetTokens
      ? truncateConversation(conversation, budgetTokens)
      : conversation;

  const result = await callModel(
    context,
    model,
    SEGMENT_SYSTEM_PROMPT,
    buildPrompt(bounded, label),
    signal,
  );

  const nextUsage = addUsage(usage, result.usage);

  if (result.truncated && depth < MAX_SPLIT_DEPTH && messages.length > 1) {
    const middle = Math.ceil(messages.length / 2);

    const left = await summarizeMessages(
      context,
      model,
      messages.slice(0, middle),
      buildPrompt,
      `part 1 of 2 of ${label}`,
      signal,
      budgetTokens,
      depth + 1,
      nextUsage,
    );

    const right = await summarizeMessages(
      context,
      model,
      messages.slice(middle),
      buildPrompt,
      `part 2 of 2 of ${label}`,
      signal,
      budgetTokens,
      depth + 1,
      left.usage,
    );

    return { text: `${left.text}\n\n${right.text}`, usage: right.usage };
  }

  return { text: result.text, usage: nextUsage };
}

/** Format rules for the summary a reduction produces. */
interface SummarySpec {
  instructions: string;
  /** Instructions used instead when a previous checkpoint is being updated. */
  updateInstructions?: string;
  /** Sections a usable summary must contain; empty when the caller supplies its own prompt. */
  sections: readonly string[];
}

/** Compaction format, matching Pi's initial and update instructions. */
const COMPACTION_SPEC: SummarySpec = {
  instructions: PI_SUMMARY_TEXT.initialInstructions,
  updateInstructions: PI_SUMMARY_TEXT.updateInstructions,
  sections: CHECKPOINT_SECTIONS,
};

/** Reduces segment digests, plus any previous checkpoint, into one structured summary. */
async function reduceDigests(
  context: CompactionContext,
  model: CompactionModel,
  digests: string[],
  budgetTokens: number,
  previousSummary: string | undefined,
  customInstructions: string | undefined,
  signal: AbortSignal,
  usage: Usage,
  spec: SummarySpec,
): Promise<{ text: string; usage: Usage }> {
  const focus = customInstructions ? `\n\nAdditional focus: ${customInstructions}` : "";

  const previous = previousSummary
    ? `\n\n<previous-summary>\n${previousSummary}\n</previous-summary>`
    : "";

  let level = digests;
  let accumulated = usage;

  while (level.length > 1) {
    const reduced = await mergeDigests(context, model, level, budgetTokens, signal, accumulated);

    accumulated = reduced.usage;

    if (reduced.level.length === level.length) break;

    level = reduced.level;
  }

  // A digest that still fills the budget, or a level that could not shrink, would leave
  // the checkpoint too little output room. Trim it explicitly instead.
  const digestInput = level.join("\n\n---\n\n");

  const boundedLevel =
    textTokens(digestInput) > budgetTokens
      ? [truncateConversation(digestInput, budgetTokens)]
      : level;

  let result = await finalCheckpoint(context, model, boundedLevel, previous, focus, signal, spec);

  accumulated = addUsage(accumulated, result.usage);

  // A summary that stopped at the cap carries partial text, so it is never persisted.
  if (result.truncated) return { text: "", usage: accumulated };

  // A model that ignores the template gets one reminder, as in OpenCode's compaction.
  if (!hasSections(result.text, spec.sections)) {
    result = await finalCheckpoint(
      context,
      model,
      boundedLevel,
      previous,
      focus,
      signal,
      spec,
      CHECKPOINT_NUDGE,
    );
    accumulated = addUsage(accumulated, result.usage);
  }

  if (result.truncated || !hasSections(result.text, spec.sections)) {
    return { text: "", usage: accumulated };
  }

  return { text: result.text, usage: accumulated };
}

/** Merges digests in budget-sized batches, leaving a lone batch untouched. */
async function mergeDigests(
  context: CompactionContext,
  model: CompactionModel,
  level: string[],
  budgetTokens: number,
  signal: AbortSignal,
  usage: Usage,
): Promise<{ level: string[]; usage: Usage }> {
  const batches = batchByBudget(level, budgetTokens);

  if (batches.length === level.length) return { level, usage };

  const merged: string[] = [];
  let accumulated = usage;

  for (const batch of batches) {
    if (batch.length === 1) {
      merged.push(batch[0]);
      continue;
    }

    const result = await callModel(
      context,
      model,
      MERGE_SYSTEM_PROMPT,
      `<digests>\n${batch.join("\n\n---\n\n")}\n</digests>\n\nMerge these digests of consecutive conversation segments into one dense digest. Keep every distinct fact, file path, command, error message, and decision. Remove repetition. Stay under 600 words.`,
      signal,
    );

    accumulated = addUsage(accumulated, result.usage);

    // A merge that stopped at the cap drops facts silently, so keep its inputs instead.
    if (result.truncated) merged.push(...batch);
    else merged.push(result.text);
  }

  return { level: merged, usage: accumulated };
}

/** Requests the structured summary that replaces the summarized messages. */
function finalCheckpoint(
  context: CompactionContext,
  model: CompactionModel,
  level: string[],
  previous: string,
  focus: string,
  signal: AbortSignal,
  spec: SummarySpec,
  nudge?: string,
): Promise<ModelResult> {
  const instructions = previous
    ? (spec.updateInstructions ?? spec.instructions)
    : spec.instructions;

  const reminder = nudge ? `\n\n${nudge}` : "";
  const prompt = `<digests>\n${level.join("\n\n---\n\n")}\n</digests>${previous}${focus}\n\n${instructions}${reminder}`;

  return callModel(context, model, PI_SUMMARY_TEXT.systemPrompt, prompt, signal);
}

/** Reports whether a summary carries every section its format requires. */
function hasSections(text: string, sections: readonly string[]): boolean {
  return sections.every((section) => text.includes(section));
}

/** Unions current file operations with the previous checkpoint's cumulative lists. */
function computeFileLists(fileOperations: CompactionFileOperations, previous?: FileListsDetails) {
  const modified = new Set<string>([...fileOperations.edited, ...fileOperations.written]);

  for (const file of previous?.modifiedFiles ?? []) modified.add(file);

  const read = new Set<string>(fileOperations.read);

  for (const file of previous?.readFiles ?? []) read.add(file);

  for (const file of modified) read.delete(file);

  return { readFiles: [...read].sort(), modifiedFiles: [...modified].sort() };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];

  if (readFiles.length > 0) {
    sections.push(`${PI_SUMMARY_TEXT.readFilesTag}\n${readFiles.join("\n")}\n</read-files>`);
  }

  if (modifiedFiles.length > 0) {
    sections.push(
      `${PI_SUMMARY_TEXT.modifiedFilesTag}\n${modifiedFiles.join("\n")}\n</modified-files>`,
    );
  }

  return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}

/** Accepts a stored `details` value that carries string file lists. */
function isFileListsDetails(value: unknown): value is FileListsDetails {
  if (typeof value !== "object" || value === null) return false;

  if (!("readFiles" in value) && !("modifiedFiles" in value)) return false;

  const readFiles = "readFiles" in value ? value.readFiles : undefined;
  const modifiedFiles = "modifiedFiles" in value ? value.modifiedFiles : undefined;

  return (
    (readFiles === undefined || isStringArray(readFiles)) &&
    (modifiedFiles === undefined || isStringArray(modifiedFiles))
  );
}

/** Returns the cumulative file lists of the newest compaction entry on the branch. */
function previousFileLists(
  branchEntries: readonly CompactionBranchEntry[],
): FileListsDetails | undefined {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index];

    if (entry.type !== "compaction") continue;

    if (isFileListsDetails(entry.details)) return entry.details;
  }

  return undefined;
}

/**
 * Builds the `session_before_compact` handler used for the free-tier provider.
 *
 * Free-tier models combine a comparatively small context window with a clamped
 * output allowance, so Pi's single-request summary can be left with too few
 * tokens to finish: the response stops at the cap and Pi discards the partial
 * checkpoint. This handler keeps the user's model and summarizes in segments
 * instead, deferring to Pi's native compaction whenever one request has room.
 *
 * @param providerId - Provider whose compaction requests this handler takes over
 * @returns A handler that returns a compaction, cancels, or defers to Pi
 */
export function createChunkedCompactionHandler(
  providerId: string,
): (
  event: CompactionEvent,
  context: CompactionContext,
) => Promise<SessionBeforeCompactResult | undefined> {
  return async (event, context) => {
    // Leave every other provider to Pi's native compaction.
    if (context.model?.provider !== providerId) return undefined;

    const model = context.model;
    const { preparation, branchEntries, customInstructions, signal, reason } = event;
    const { messagesToSummarize: history, turnPrefixMessages: turnPrefix } = preparation;
    const messages = [...history, ...turnPrefix];

    if (messages.length === 0) return undefined;

    const contextWindow = model.contextWindow ?? 0;

    if (contextWindow <= 0) return undefined;

    // Pi's own reserve decides whether one request still has room; the settings Pi
    // resolved for this session carry it, so the threshold follows the user's config.
    const reserveTokens = preparation.settings?.reserveTokens ?? DEFAULT_RESERVE_TOKENS;

    const instructions = preparation.previousSummary
      ? PI_SUMMARY_TEXT.updateInstructions
      : PI_SUMMARY_TEXT.initialInstructions;

    const singleShotInput =
      textTokens(serialize(messages)) +
      promptOverheadTokens(
        preparation.previousSummary,
        customInstructions,
        instructions,
        PI_SUMMARY_TEXT.systemPrompt,
      );

    const singleShotOutput = Math.min(
      model.maxTokens ?? 0,
      contextWindow - singleShotInput - WINDOW_SAFETY_TOKENS,
    );

    if (singleShotOutput >= reserveTokens) return undefined;

    const budget = requestInputBudget(contextWindow);
    const segments = segmentMessages(history, budget);
    const segmentCount = Math.max(segments.length, 1);

    let usage = emptyUsage();

    try {
      context.setStatus(
        `compacting ${singleShotInput.toLocaleString()} tokens in ${segmentCount} ${segmentCount === 1 ? "segment" : "segments"}`,
      );

      // Pi keeps the previous checkpoint when a split turn leaves nothing before the tail.
      let summary = preparation.previousSummary ?? "No prior history.";

      if (segments.length > 0) {
        const digests: string[] = [];

        for (const [index, segment] of segments.entries()) {
          const digest = await summarizeMessages(
            context,
            model,
            segment,
            segmentPrompt,
            `segment ${index + 1} of ${segments.length}`,
            signal,
            budget,
            0,
            usage,
          );

          usage = digest.usage;

          if (digest.text) digests.push(digest.text);
        }

        if (digests.length === 0) {
          context.notify(
            "Segmented compaction produced no summary; using Pi's compaction",
            "warning",
          );

          return undefined;
        }

        const checkpoint = await reduceDigests(
          context,
          model,
          digests,
          budget,
          preparation.previousSummary,
          customInstructions,
          signal,
          usage,
          COMPACTION_SPEC,
        );

        usage = checkpoint.usage;

        if (!checkpoint.text) {
          context.notify(
            "Segmented compaction produced an empty summary; using Pi's compaction",
            "warning",
          );

          return undefined;
        }

        summary = checkpoint.text;
      }

      // Pi summarizes a split turn's prefix separately and splices it in with a marker.
      if (turnPrefix.length > 0) {
        const prefix = await summarizeMessages(
          context,
          model,
          turnPrefix,
          turnPrefixPrompt(customInstructions),
          "turn prefix",
          signal,
          budget,
          0,
          usage,
        );

        usage = prefix.usage;

        if (!prefix.text) {
          context.notify(
            "Segmented compaction produced no turn prefix summary; using Pi's compaction",
            "warning",
          );

          return undefined;
        }

        summary = `${summary}\n\n---\n\n${PI_SUMMARY_TEXT.turnPrefixMarker}\n\n${prefix.text}`;
      }

      const files = computeFileLists(preparation.fileOps, previousFileLists(branchEntries));

      context.notify(
        `Compacted ${messages.length} messages (${preparation.tokensBefore.toLocaleString()} tokens) in ${segmentCount} ${segmentCount === 1 ? "segment" : "segments"}`,
        "info",
      );

      return {
        compaction: {
          summary: summary + formatFileOperations(files.readFiles, files.modifiedFiles),
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage,
          details: files,
        },
      };
    } catch (error) {
      if (signal.aborted) return { cancel: true };

      const message = error instanceof Error ? error.message : String(error);
      context.notify(
        `Segmented compaction (${reason}) failed: ${message}. Using Pi's compaction.`,
        "warning",
      );

      return undefined;
    } finally {
      context.setStatus(undefined);
    }
  };
}

/**
 * Builds the `session_before_tree` handler that summarizes a branch in segments.
 *
 * `/tree` asks for a branch summary when the user leaves an explored branch. Pi answers
 * that with one request sized like a compaction request, so a long branch on a free-tier
 * model can lose the same output room compaction loses. This handler reuses Pi's own
 * entry selection and file operations, splits the branch when one request would starve
 * the answer, and defers to Pi whenever one request has room to finish.
 */
export function createBranchSummaryHandler(
  providerId: string,
): (event: BranchEvent, context: CompactionContext) => Promise<BranchResult | undefined> {
  return async (event, context) => {
    if (context.model?.provider !== providerId) return undefined;

    const { preparation, signal } = event;

    // "No summary" in the `/tree` dialog means Pi will not summarize at all.
    if (!preparation.userWantsSummary) return undefined;

    const model = context.model;
    const contextWindow = model.contextWindow ?? 0;

    if (contextWindow <= 0) return undefined;

    // Pi selects the entries that fit beside its reserve; the file operations come with them.
    const prepared = prepareBranchEntries(
      preparation.entriesToSummarize,
      Math.max(0, contextWindow - DEFAULT_RESERVE_TOKENS),
    );

    if (prepared.messages.length === 0) {
      return { summary: { summary: "No content to summarize" } };
    }

    const customInstructions = preparation.customInstructions;
    const replace = preparation.replaceInstructions === true && customInstructions !== undefined;

    // Pi appends custom instructions as focus unless they are asked to replace the prompt.
    const instructions = replace ? customInstructions : PI_SUMMARY_TEXT.branchInstructions;

    const singleShotOutput = Math.min(
      model.maxTokens ?? 0,
      contextWindow -
        textTokens(serializeConversation(convertToLlm(prepared.messages))) -
        promptOverheadTokens(
          instructions,
          replace ? undefined : customInstructions,
          PI_SUMMARY_TEXT.systemPrompt,
        ) -
        WINDOW_SAFETY_TOKENS,
    );

    if (singleShotOutput >= DEFAULT_RESERVE_TOKENS) return undefined;

    const budget = requestInputBudget(contextWindow);
    const segments = segmentMessages(prepared.messages, budget);

    const spec: SummarySpec = replace
      ? { instructions: customInstructions, sections: [] }
      : { instructions: PI_SUMMARY_TEXT.branchInstructions, sections: BRANCH_SECTIONS };

    const focus = replace ? undefined : customInstructions;

    let usage = emptyUsage();

    try {
      context.setStatus(
        `summarizing branch in ${segments.length} ${segments.length === 1 ? "segment" : "segments"}`,
      );

      const digests: string[] = [];

      for (const [index, segment] of segments.entries()) {
        const digest = await summarizeMessages(
          context,
          model,
          segment,
          segmentPrompt,
          `branch part ${index + 1} of ${segments.length}`,
          signal,
          budget,
          0,
          usage,
        );

        usage = digest.usage;

        if (digest.text) digests.push(digest.text);
      }

      if (digests.length === 0) {
        context.notify(
          "Segmented branch summary produced no digests; using Pi's branch summary",
          "warning",
        );

        return undefined;
      }

      const reduced = await reduceDigests(
        context,
        model,
        digests,
        budget,
        undefined,
        focus,
        signal,
        usage,
        spec,
      );

      usage = reduced.usage;

      if (!reduced.text) {
        context.notify(
          "Segmented branch summary produced no usable summary; using Pi's branch summary",
          "warning",
        );

        return undefined;
      }

      const files = computeFileLists(prepared.fileOps);

      context.notify(
        `Summarized branch: ${prepared.messages.length} messages in ${segments.length} ${segments.length === 1 ? "segment" : "segments"}`,
        "info",
      );

      return {
        summary: {
          summary:
            PI_SUMMARY_TEXT.branchPreamble +
            reduced.text +
            formatFileOperations(files.readFiles, files.modifiedFiles),
          details: files,
          usage,
        },
      };
    } catch (error) {
      if (signal.aborted) return { cancel: true };

      const message = error instanceof Error ? error.message : String(error);
      context.notify(
        `Segmented branch summary failed: ${message}. Using Pi's branch summary.`,
        "warning",
      );

      return undefined;
    } finally {
      context.setStatus(undefined);
    }
  };
}

/**
 * Adapts Pi's extension context to the slice segmented compaction needs.
 *
 * The session model is captured once and reused, so compaction cannot change the
 * selected model, and `reasoning` is left unset on every request.
 */
function createPiCompactionContext(
  context: ExtensionContext,
  createSessionId: () => string,
  statusKey: string = STATUS_KEY,
): CompactionContext | undefined {
  const model = context.model;

  if (!model) return undefined;

  return {
    model,
    notify: (message, type) => context.ui.notify(message, type),
    setStatus: (text) => context.ui.setStatus(statusKey, text),
    complete: async ({ systemPrompt, prompt, signal }) => {
      const response = await context.modelRegistry
        .streamSimple(
          model,
          {
            systemPrompt,
            messages: [
              { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
            ],
          },
          { signal, cacheRetention: "none", sessionId: createSessionId() },
        )
        .result();

      return {
        text: response.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .filter((chunk) => chunk.length > 0)
          .join("\n"),
        usage: response.usage,
        stopReason: response.stopReason,
        errorMessage: response.errorMessage,
        hasToolCalls: response.content.some((block) => block.type === "toolCall"),
      };
    },
  };
}

/**
 * Registers the segmented compaction handler for one provider.
 *
 * @param pi - Extension API supplied by Pi
 * @param providerId - Provider whose compaction requests the handler takes over
 * @param dependencies - Injectable dependencies for tests
 */
export function registerChunkedCompaction(
  pi: ExtensionAPI,
  providerId: string,
  dependencies: ChunkedCompactionDependencies = {},
): void {
  const handler = createChunkedCompactionHandler(providerId);
  const createSessionId = dependencies.createSessionId ?? (() => uuidv7());

  pi.on("session_before_compact", async (event, context) => {
    const compactionContext = createPiCompactionContext(context, createSessionId);

    if (!compactionContext) return undefined;

    return handler(event, compactionContext);
  });
}

/**
 * Registers the segmented branch-summary handler for one provider.
 *
 * @param pi - Extension API supplied by Pi
 * @param providerId - Provider whose branch summaries the handler takes over
 * @param dependencies - Injectable dependencies for tests
 */
export function registerBranchSummary(
  pi: ExtensionAPI,
  providerId: string,
  dependencies: ChunkedCompactionDependencies = {},
): void {
  const handler = createBranchSummaryHandler(providerId);
  const createSessionId = dependencies.createSessionId ?? (() => uuidv7());

  pi.on("session_before_tree", async (event, context) => {
    const summaryContext = createPiCompactionContext(context, createSessionId, BRANCH_STATUS_KEY);

    if (!summaryContext) return undefined;

    return handler(event, summaryContext);
  });
}
