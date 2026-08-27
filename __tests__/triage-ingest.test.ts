import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockGetUserMedia, mockGetRecentMediaComments, mockDecryptToken, mockClassifyComments } =
  vi.hoisted(() => ({
    mockPrisma: {
      instagramAccount: { findMany: vi.fn() },
      triagedComment: { findMany: vi.fn(), create: vi.fn() },
    },
    mockGetUserMedia: vi.fn(),
    mockGetRecentMediaComments: vi.fn(),
    mockDecryptToken: vi.fn(),
    mockClassifyComments: vi.fn(),
  }));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", () => ({
  getUserMedia: mockGetUserMedia,
  getRecentMediaComments: mockGetRecentMediaComments,
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));
vi.mock("@/lib/triage/classify", () => ({ classifyComments: mockClassifyComments }));

import { sweepTriageComments } from "../lib/triage/ingest";

const account = {
  id: "acct_1",
  workspaceId: "ws_1",
  instagramId: "ig_1",
  accessToken: "encrypted",
  automations: [
    { id: "auto_1", postId: "media_1", matchAnyPost: false, matchAnyWord: false, keywords: ["برومبت"], wholeWordMatch: true },
  ],
};

const post = {
  id: "media_1",
  caption: "post caption",
  media_type: "VIDEO",
  timestamp: new Date().toISOString(),
  thumbnail_url: "https://example.com/thumb.jpg",
};

beforeEach(() => {
  mockPrisma.instagramAccount.findMany.mockReset();
  mockPrisma.triagedComment.findMany.mockReset();
  mockPrisma.triagedComment.create.mockReset();
  mockGetUserMedia.mockReset();
  mockGetRecentMediaComments.mockReset();
  mockDecryptToken.mockReset();
  mockClassifyComments.mockReset();

  mockPrisma.instagramAccount.findMany.mockResolvedValue([account]);
  mockGetUserMedia.mockResolvedValue([post]);
  mockDecryptToken.mockReturnValue("decrypted-token");
  mockPrisma.triagedComment.create.mockResolvedValue({});
  mockClassifyComments.mockResolvedValue(new Map());
});

describe("sweepTriageComments", () => {
  it("classifies a keyword-matching comment as KEYWORD_MATCH without calling the LLM", async () => {
    mockPrisma.triagedComment.findMany.mockResolvedValue([]);
    mockGetRecentMediaComments.mockResolvedValue([
      { id: "c1", text: "ابي البرومبت", timestamp: new Date().toISOString(), from: { id: "u1", username: "someone" } },
    ]);

    await sweepTriageComments();

    expect(mockClassifyComments).toHaveBeenCalledWith([]);
    expect(mockPrisma.triagedComment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ commentId: "c1", classification: "KEYWORD_MATCH" }),
      })
    );
  });

  it("sends only non-keyword comments to the LLM", async () => {
    mockPrisma.triagedComment.findMany.mockResolvedValue([]);
    mockGetRecentMediaComments.mockResolvedValue([
      { id: "c1", text: "ابي البرومبت", timestamp: new Date().toISOString(), from: { id: "u1" } },
      { id: "c2", text: "this changed how I think about it", timestamp: new Date().toISOString(), from: { id: "u2" } },
    ]);
    mockClassifyComments.mockResolvedValue(new Map([["c2", "GENUINE"]]));

    await sweepTriageComments();

    expect(mockClassifyComments).toHaveBeenCalledWith([
      { commentId: "c2", text: "this changed how I think about it", mediaCaption: "post caption" },
    ]);
    expect(mockPrisma.triagedComment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ commentId: "c2", classification: "GENUINE" }) })
    );
  });

  it("never re-classifies a comment already stored (cache hit)", async () => {
    mockPrisma.triagedComment.findMany.mockResolvedValue([{ commentId: "c1" }]);
    mockGetRecentMediaComments.mockResolvedValue([
      { id: "c1", text: "already seen this one", timestamp: new Date().toISOString(), from: { id: "u1" } },
    ]);

    await sweepTriageComments();

    expect(mockClassifyComments).toHaveBeenCalledWith([]);
    expect(mockPrisma.triagedComment.create).not.toHaveBeenCalled();
  });

  it("skips a comment the LLM failed to classify, without creating a row", async () => {
    mockPrisma.triagedComment.findMany.mockResolvedValue([]);
    mockGetRecentMediaComments.mockResolvedValue([
      { id: "c2", text: "unclear text", timestamp: new Date().toISOString(), from: { id: "u2" } },
    ]);
    mockClassifyComments.mockResolvedValue(new Map()); // model returned nothing usable

    await sweepTriageComments();

    expect(mockPrisma.triagedComment.create).not.toHaveBeenCalled();
  });

  it("still sweeps a post older than the lookback window (comment-level filtering handles recency, not post age)", async () => {
    const oldPost = { ...post, timestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() }; // 30 days old
    mockGetUserMedia.mockResolvedValue([oldPost]);
    mockPrisma.triagedComment.findMany.mockResolvedValue([]);
    mockGetRecentMediaComments.mockResolvedValue([
      { id: "c1", text: "a brand new comment on an old post", timestamp: new Date().toISOString(), from: { id: "u1" } },
    ]);
    mockClassifyComments.mockResolvedValue(new Map([["c1", "GENUINE"]]));

    await sweepTriageComments();

    expect(mockGetRecentMediaComments).toHaveBeenCalledWith("decrypted-token", oldPost.id, expect.any(Number));
    expect(mockPrisma.triagedComment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ commentId: "c1", classification: "GENUINE" }) })
    );
  });

  it("still processes a second post's comments when the first post's comment fetch fails", async () => {
    const post2 = { ...post, id: "media_2" };
    mockGetUserMedia.mockResolvedValue([post, post2]);
    mockPrisma.triagedComment.findMany.mockResolvedValue([]);
    mockGetRecentMediaComments.mockImplementation(async (_token: string, mediaId: string) => {
      if (mediaId === "media_1") throw new Error("transient Graph API error");
      return [{ id: "c2", text: "a real comment on the second post", timestamp: new Date().toISOString(), from: { id: "u2" } }];
    });
    mockClassifyComments.mockResolvedValue(new Map([["c2", "GENUINE"]]));

    await sweepTriageComments();

    expect(mockPrisma.triagedComment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ commentId: "c2" }) })
    );
  });
});
