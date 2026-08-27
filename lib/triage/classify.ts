/**
 * LLM-based comment classification for triage.
 *
 * Only called for comments that did NOT match any automation keyword (see
 * keyword-scope.ts) — those are already classified as KEYWORD_MATCH for free.
 * Results are cached forever by the caller (ingest.ts persists them on the
 * TriagedComment row), so a given commentId is classified at most once.
 */

import OpenAI from "openai";

const MODEL = process.env.TRIAGE_CLASSIFY_MODEL ?? "gpt-5-nano";
const BATCH_SIZE = 20;

export type ClassificationLabel = "GENUINE" | "LOW_EFFORT" | "SPAM";

export interface CommentToClassify {
  commentId: string;
  text: string;
  mediaCaption: string | null;
}

const LABEL_SCHEMA = {
  type: "object",
  properties: {
    labels: {
      type: "array",
      items: { type: "string", enum: ["GENUINE", "LOW_EFFORT", "SPAM"] },
    },
  },
  required: ["labels"],
  additionalProperties: false,
} as const;

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is required");
    }
    client = new OpenAI({ apiKey });
  }
  return client;
}

export async function classifyComments(
  comments: CommentToClassify[]
): Promise<Map<string, ClassificationLabel>> {
  const result = new Map<string, ClassificationLabel>();
  if (comments.length === 0) return result;

  for (let i = 0; i < comments.length; i += BATCH_SIZE) {
    const batch = comments.slice(i, i + BATCH_SIZE);
    const classified = await classifyBatch(batch);
    for (const [id, label] of classified) result.set(id, label);
  }

  return result;
}

async function classifyBatch(
  batch: CommentToClassify[]
): Promise<Map<string, ClassificationLabel>> {
  try {
    const response = await getClient().responses.create({
      model: MODEL,
      input: buildPrompt(batch),
      text: {
        format: {
          type: "json_schema",
          name: "comment_labels",
          schema: LABEL_SCHEMA,
          strict: true,
        },
      },
    });

    return parseBatchResponse(batch, response.output_text);
  } catch (error) {
    // Isolate this batch's failure so earlier batches' results survive.
    // Same philosophy as the malformed-JSON case: leave unclassified, next
    // sweep retries.
    console.error(
      "[Triage] Classification batch failed:",
      error instanceof Error ? error.message : error
    );
    return new Map();
  }
}

function buildPrompt(batch: CommentToClassify[]): string {
  const lines = batch.map(
    (c, i) => `${i + 1}. [post: ${c.mediaCaption ?? "(no caption)"}] comment: "${c.text}"`
  );
  return (
    "Classify each Instagram comment below as exactly one label: GENUINE " +
    "(a real reaction, question, or opinion worth a personal reply), LOW_EFFORT " +
    '(an emoji-only or generic one-word reaction like "nice" or "🔥"), or SPAM ' +
    "(a scam, bot, or completely unrelated to the post).\n\n" +
    lines.join("\n") +
    '\n\nRespond with a JSON object of the form {"labels": [...]} containing ' +
    "the labels in the same order as the comments above."
  );
}

function parseBatchResponse(
  batch: CommentToClassify[],
  responseText: string
): Map<string, ClassificationLabel> {
  const result = new Map<string, ClassificationLabel>();

  const cleaned = responseText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Malformed response: leave these unclassified rather than guess. The
    // next sweep will see them as not-yet-in-the-table and retry.
    return result;
  }

  const labels =
    parsed && typeof parsed === "object" && "labels" in parsed
      ? (parsed as { labels: unknown }).labels
      : undefined;
  if (!Array.isArray(labels)) return result;

  batch.forEach((comment, i) => {
    const label = labels[i];
    if (label === "GENUINE" || label === "LOW_EFFORT" || label === "SPAM") {
      result.set(comment.commentId, label);
    }
  });

  return result;
}
