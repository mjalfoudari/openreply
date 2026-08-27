/**
 * LLM-based comment classification for triage.
 *
 * Only called for comments that did NOT match any automation keyword (see
 * keyword-scope.ts) — those are already classified as KEYWORD_MATCH for free.
 * Results are cached forever by the caller (ingest.ts persists them on the
 * TriagedComment row), so a given commentId is classified at most once.
 */

import Anthropic from "@anthropic-ai/sdk";

// ponytail: no date-suffixed snapshot — use the current alias id so this
// doesn't silently point at a retired model.
const MODEL = process.env.TRIAGE_CLASSIFY_MODEL ?? "claude-haiku-4-5";
const BATCH_SIZE = 20;

export type ClassificationLabel = "GENUINE" | "LOW_EFFORT" | "SPAM";

export interface CommentToClassify {
  commentId: string;
  text: string;
  mediaCaption: string | null;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable is required");
    }
    client = new Anthropic({ apiKey });
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
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: buildPrompt(batch) }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  return parseBatchResponse(batch, text);
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
    '\n\nRespond with ONLY a JSON array of labels in the same order, e.g. ' +
    '["GENUINE","LOW_EFFORT","SPAM"]. No other text.'
  );
}

function parseBatchResponse(
  batch: CommentToClassify[],
  responseText: string
): Map<string, ClassificationLabel> {
  const result = new Map<string, ClassificationLabel>();

  let labels: unknown;
  try {
    labels = JSON.parse(responseText.trim());
  } catch {
    // Malformed response: leave these unclassified rather than guess. The
    // next sweep will see them as not-yet-in-the-table and retry.
    return result;
  }
  if (!Array.isArray(labels)) return result;

  batch.forEach((comment, i) => {
    const label = labels[i];
    if (label === "GENUINE" || label === "LOW_EFFORT" || label === "SPAM") {
      result.set(comment.commentId, label);
    }
  });

  return result;
}
