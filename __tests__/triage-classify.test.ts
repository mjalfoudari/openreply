import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("openai", () => ({
  default: class OpenAI {
    responses = { create: mockCreate };
  },
}));

import { classifyComments } from "../lib/triage/classify";

beforeEach(() => {
  mockCreate.mockReset();
  process.env.OPENAI_API_KEY = "test-key";
});

describe("classifyComments", () => {
  it("returns an empty map for an empty input without calling the model", async () => {
    const result = await classifyComments([]);
    expect(result.size).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("maps each comment id to its parsed label, in order", async () => {
    mockCreate.mockResolvedValue({
      output_text: '{"labels":["GENUINE","LOW_EFFORT"]}',
    });

    const result = await classifyComments([
      { commentId: "c1", text: "how do I start?", mediaCaption: "post caption" },
      { commentId: "c2", text: "🔥", mediaCaption: "post caption" },
    ]);

    expect(result.get("c1")).toBe("GENUINE");
    expect(result.get("c2")).toBe("LOW_EFFORT");
  });

  it("leaves comments unclassified if the model response isn't valid JSON", async () => {
    mockCreate.mockResolvedValue({
      output_text: "sorry, I can't help with that",
    });

    const result = await classifyComments([
      { commentId: "c1", text: "hello", mediaCaption: null },
    ]);

    expect(result.has("c1")).toBe(false);
  });

  it("leaves comments unclassified if the batch call throws", async () => {
    mockCreate.mockRejectedValue(new Error("network error"));

    const result = await classifyComments([
      { commentId: "c1", text: "hello", mediaCaption: null },
    ]);

    expect(result.has("c1")).toBe(false);
    expect(result.size).toBe(0);
  });

  it("batches more than 20 comments into multiple model calls", async () => {
    mockCreate.mockImplementation(async ({ input }: { input: string }) => {
      const count = (input.match(/\d+\.\s\[post/g) ?? []).length;
      const labels = Array.from({ length: count }, () => "GENUINE");
      return { output_text: JSON.stringify({ labels }) };
    });

    const comments = Array.from({ length: 25 }, (_, i) => ({
      commentId: `c${i}`,
      text: "hi",
      mediaCaption: null,
    }));

    const result = await classifyComments(comments);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(25);
  });

  it("strips markdown code fences before parsing the response", async () => {
    mockCreate.mockResolvedValue({
      output_text: '```json\n{"labels":["GENUINE"]}\n```',
    });

    const result = await classifyComments([
      { commentId: "c1", text: "hello", mediaCaption: null },
    ]);

    expect(result.get("c1")).toBe("GENUINE");
  });
});
