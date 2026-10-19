import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { normalizeUrl, type SafesearchMode } from "./brave";
import { requestText } from "./provider";

export const citationSchema = Type.Object({
  number: Type.Integer({ minimum: 1 }),
  url: Type.String(),
});

export const answerSchema = Type.Object({
  text: Type.String({ minLength: 1 }),
  citations: Type.Array(citationSchema),
  usage: Type.Record(Type.String(), Type.Number()),
});

export type BraveAnswer = Static<typeof answerSchema>;

const eventSchema = Type.Object({
  choices: Type.Optional(
    Type.Array(
      Type.Object({
        finish_reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        delta: Type.Optional(
          Type.Object({ content: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
        ),
      }),
    ),
  ),
  error: Type.Optional(Type.Unknown()),
});

const usageSchema = Type.Record(Type.String(), Type.Number());

/** Parses bounded SSE and concatenates content before parsing tags, which can span deltas. */
export function parseAnswerStream(body: string): BraveAnswer {
  const chunks: string[] = [];
  let completed = false;

  for (const event of body.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

    if (!data) continue;

    if (data === "[DONE]") {
      completed = true;
      break;
    }

    const parsed: unknown = JSON.parse(data);

    if (!Check(eventSchema, parsed) || parsed.error !== undefined)
      throw new Error("Brave Answers returned an invalid stream event.");
    const choice = parsed.choices?.[0];

    if (choice?.finish_reason && choice.finish_reason !== "stop") {
      throw new Error("Brave Answers did not complete the answer; try a narrower query.");
    }

    const content = choice?.delta?.content;

    if (content) chunks.push(content);
  }

  if (!completed) throw new Error("Brave Answers stream ended before completion.");

  const citations: BraveAnswer["citations"] = [];
  const seen = new Set<string>();
  let usage: BraveAnswer["usage"] = {};

  const text = chunks
    .join("")
    .replace(/<(citation|usage)>([\s\S]*?)<\/\1>/g, (_tag: string, kind: string, json: string) => {
      const parsed: unknown = JSON.parse(json);

      if (kind === "usage") {
        if (!Check(usageSchema, parsed))
          throw new Error("Brave Answers returned invalid usage metadata.");
        usage = parsed;

        return "";
      }

      if (!Check(citationSchema, parsed))
        throw new Error("Brave Answers returned invalid citation metadata.");
      const url = normalizeUrl(parsed.url);

      if (!url) return "";
      const key = `${parsed.number}:${url}`;

      if (!seen.has(key)) {
        citations.push({ number: parsed.number, url });
        seen.add(key);
      }

      return `[${parsed.number}]`;
    })
    .trim();

  if (/<\/?(?:citation|usage)\b/i.test(text))
    throw new Error("Brave Answers returned incomplete metadata tags.");

  if (!text)
    throw new Error(
      'Brave Answers returned no answer content. Try mode: "web" for sources; no answer does not prove absence.',
    );

  return { text, citations, usage };
}

/** Explicit single-search Answers call; uses the same bounded, abort-aware transport as web search. */
export async function searchBraveAnswers(
  query: string,
  signal: AbortSignal | undefined,
  apiKey: string,
  extras: { country?: string; language?: string; safesearch?: SafesearchMode },
): Promise<BraveAnswer> {
  const body = await requestText(
    "https://api.search.brave.com/res/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "X-Subscription-Token": apiKey,
      },
      body: JSON.stringify({
        model: "brave",
        stream: true,
        enable_citations: true,
        enable_research: false,
        max_completion_tokens: 4096,
        messages: [{ role: "user", content: query }],
        country: extras.country?.toLowerCase(),
        language: extras.language,
        safesearch: extras.safesearch,
      }),
    },
    signal,
  );

  return parseAnswerStream(body);
}
