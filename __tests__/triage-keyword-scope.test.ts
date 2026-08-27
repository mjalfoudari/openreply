import { describe, it, expect } from "vitest";
import { matchesAnyAutomation } from "../lib/triage/keyword-scope";

const baseAutomation = {
  id: "auto_1",
  postId: null as string | null,
  matchAnyPost: false,
  matchAnyWord: false,
  keywords: [] as string[],
  wholeWordMatch: true,
};

describe("matchesAnyAutomation", () => {
  it("matches when the post's automation keyword is in the comment", () => {
    const automations = [
      { ...baseAutomation, postId: "media_1", keywords: ["برومبت"] },
    ];
    expect(matchesAnyAutomation(automations, "media_1", "ابي البرومبت")).toBe(true);
  });

  it("does not match when the comment is on a different post", () => {
    const automations = [
      { ...baseAutomation, postId: "media_1", keywords: ["برومبت"] },
    ];
    expect(matchesAnyAutomation(automations, "media_2", "ابي البرومبت")).toBe(false);
  });

  it("does not match when keywords don't hit", () => {
    const automations = [
      { ...baseAutomation, postId: "media_1", keywords: ["برومبت"] },
    ];
    expect(matchesAnyAutomation(automations, "media_1", "شكرا")).toBe(false);
  });

  it("matches any post when matchAnyPost is set", () => {
    const automations = [
      { ...baseAutomation, matchAnyPost: true, keywords: ["مهتم"] },
    ];
    expect(matchesAnyAutomation(automations, "any_media_id", "مهتم")).toBe(true);
  });

  it("matches any word when matchAnyWord is set, regardless of text", () => {
    const automations = [
      { ...baseAutomation, postId: "media_1", matchAnyWord: true },
    ];
    expect(matchesAnyAutomation(automations, "media_1", "anything at all")).toBe(true);
  });

  it("returns false for an empty automation list", () => {
    expect(matchesAnyAutomation([], "media_1", "برومبت")).toBe(false);
  });

  it("postId takes priority over matchAnyPost when both are set (matches reconciler's if/else)", () => {
    const automations = [
      { ...baseAutomation, postId: "media_1", matchAnyPost: true, keywords: ["مهتم"] },
    ];
    expect(matchesAnyAutomation(automations, "media_2", "مهتم")).toBe(false);
  });
});
