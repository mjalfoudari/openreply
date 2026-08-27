import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockSendCommentReply, mockDecryptToken } = vi.hoisted(() => ({
  mockPrisma: {
    triagedComment: { findFirst: vi.fn(), update: vi.fn() },
  },
  mockSendCommentReply: vi.fn(),
  mockDecryptToken: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", () => ({
  sendCommentReply: mockSendCommentReply,
  MetaApiError: class MetaApiError extends Error {
    code: number;
    constructor(
      code: number,
      _subcode: number | undefined,
      _fbTraceId: string | undefined,
      message: string
    ) {
      super(message);
      this.code = code;
      this.name = "MetaApiError";
    }
  },
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));

import { replyToTriagedComment, dismissTriagedComment } from "../lib/triage/actions";
import { MetaApiError } from "@/lib/meta/client";

beforeEach(() => {
  mockPrisma.triagedComment.findFirst.mockReset();
  mockPrisma.triagedComment.update.mockReset();
  mockSendCommentReply.mockReset();
  mockDecryptToken.mockReset();
});

describe("replyToTriagedComment", () => {
  it("posts the reply and marks the comment HANDLED", async () => {
    mockPrisma.triagedComment.findFirst.mockResolvedValue({
      id: "tc_1",
      commentId: "c1",
      instagramAccount: { accessToken: "encrypted" },
    });
    mockDecryptToken.mockReturnValue("decrypted-token");
    mockSendCommentReply.mockResolvedValue({ id: "reply_1" });

    const result = await replyToTriagedComment("ws_1", "tc_1", "Thanks!");

    expect(result).toEqual({ success: true });
    expect(mockSendCommentReply).toHaveBeenCalledWith("decrypted-token", "c1", "Thanks!");
    expect(mockPrisma.triagedComment.update).toHaveBeenCalledWith({
      where: { id: "tc_1" },
      data: expect.objectContaining({ status: "HANDLED", repliedText: "Thanks!" }),
    });
  });

  it("returns an error and does not update when the comment isn't found in this workspace", async () => {
    mockPrisma.triagedComment.findFirst.mockResolvedValue(null);

    const result = await replyToTriagedComment("ws_1", "tc_missing", "Thanks!");

    expect(result).toEqual({ success: false, error: "Comment not found" });
    expect(mockPrisma.triagedComment.update).not.toHaveBeenCalled();
  });

  it("returns an error when the comment has no Instagram account attached", async () => {
    mockPrisma.triagedComment.findFirst.mockResolvedValue({
      id: "tc_1",
      commentId: "c1",
      instagramAccount: null,
    });

    const result = await replyToTriagedComment("ws_1", "tc_1", "Thanks!");

    expect(result).toEqual({ success: false, error: "No Instagram account on this comment" });
  });

  it("catches a Meta API error from sendCommentReply and returns it as a result instead of throwing", async () => {
    mockPrisma.triagedComment.findFirst.mockResolvedValue({
      id: "tc_1",
      commentId: "c1",
      instagramAccount: { accessToken: "encrypted" },
    });
    mockDecryptToken.mockReturnValue("decrypted-token");
    mockSendCommentReply.mockRejectedValue(new Error("rate limited"));

    const result = await replyToTriagedComment("ws_1", "tc_1", "Thanks!");

    expect(result).toEqual({ success: false, error: "rate limited" });
    expect(mockPrisma.triagedComment.update).not.toHaveBeenCalled();
  });

  it("formats a MetaApiError with its code, distinct from a generic error", async () => {
    mockPrisma.triagedComment.findFirst.mockResolvedValue({
      id: "tc_1",
      commentId: "c1",
      instagramAccount: { accessToken: "encrypted" },
    });
    mockDecryptToken.mockReturnValue("decrypted-token");
    mockSendCommentReply.mockRejectedValue(new MetaApiError(4, undefined, undefined, "rate limited"));

    const result = await replyToTriagedComment("ws_1", "tc_1", "Thanks!");

    expect(result).toEqual({ success: false, error: "Meta 4: rate limited" });
    expect(mockPrisma.triagedComment.update).not.toHaveBeenCalled();
  });

  it("catches a Prisma error from findFirst and returns it as a result instead of throwing", async () => {
    mockPrisma.triagedComment.findFirst.mockRejectedValue(new Error("connection refused"));

    const result = await replyToTriagedComment("ws_1", "tc_1", "Thanks!");

    expect(result).toEqual({ success: false, error: "connection refused" });
    expect(mockPrisma.triagedComment.update).not.toHaveBeenCalled();
  });

  it("catches a Prisma error from update and returns it as a result instead of throwing", async () => {
    mockPrisma.triagedComment.findFirst.mockResolvedValue({
      id: "tc_1",
      commentId: "c1",
      instagramAccount: { accessToken: "encrypted" },
    });
    mockDecryptToken.mockReturnValue("decrypted-token");
    mockSendCommentReply.mockResolvedValue({ id: "reply_1" });
    mockPrisma.triagedComment.update.mockRejectedValue(new Error("connection refused"));

    const result = await replyToTriagedComment("ws_1", "tc_1", "Thanks!");

    expect(result).toEqual({ success: false, error: "connection refused" });
  });
});

describe("dismissTriagedComment", () => {
  it("marks the comment DISMISSED", async () => {
    mockPrisma.triagedComment.findFirst.mockResolvedValue({ id: "tc_1" });

    const result = await dismissTriagedComment("ws_1", "tc_1");

    expect(result).toEqual({ success: true });
    expect(mockPrisma.triagedComment.update).toHaveBeenCalledWith({
      where: { id: "tc_1" },
      data: expect.objectContaining({ status: "DISMISSED" }),
    });
  });

  it("returns an error when the comment isn't found in this workspace", async () => {
    mockPrisma.triagedComment.findFirst.mockResolvedValue(null);

    const result = await dismissTriagedComment("ws_1", "tc_missing");

    expect(result).toEqual({ success: false, error: "Comment not found" });
  });
});
