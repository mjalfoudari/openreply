import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";

export const runtime = "nodejs";

export interface TriagedCommentListItem {
  id: string;
  mediaId: string;
  mediaThumbnailUrl: string | null;
  mediaCaption: string | null;
  authorUsername: string | null;
  text: string;
  createdAt: string;
  classification: string;
}

export interface TriagedCommentListResponse {
  comments: TriagedCommentListItem[];
}

// Pending comments for the workspace. `view=filtered` returns the read-only
// spot-check list (keyword hits + LLM-flagged low-effort/spam) instead of the
// main genuine-comment queue.
export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const view = request.nextUrl.searchParams.get("view") === "filtered" ? "filtered" : "pending";

  const rows = await prisma.triagedComment.findMany({
    where:
      view === "filtered"
        ? { workspaceId, status: "PENDING", classification: { not: "GENUINE" } }
        : { workspaceId, status: "PENDING", classification: "GENUINE" },
    orderBy: { createdAt: "asc" },
    take: 200,
  });

  const comments: TriagedCommentListItem[] = rows.map((r) => ({
    id: r.id,
    mediaId: r.mediaId,
    mediaThumbnailUrl: r.mediaThumbnailUrl,
    mediaCaption: r.mediaCaption,
    authorUsername: r.authorUsername,
    text: r.text,
    createdAt: r.createdAt.toISOString(),
    classification: r.classification,
  }));

  const body: { success: true; data: TriagedCommentListResponse } = {
    success: true,
    data: { comments },
  };
  return NextResponse.json(body);
}
