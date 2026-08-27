/**
 * Reply / dismiss actions for a triaged comment. Both are scoped to
 * workspaceId via findFirst so one workspace can never touch another's row.
 */

import { prisma } from "@/lib/db/client";
import { sendCommentReply, MetaApiError } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";

export type TriageActionResult = { success: true } | { success: false; error: string };

function formatMetaError(error: unknown): string {
  if (error instanceof MetaApiError) return `Meta ${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

export async function replyToTriagedComment(
  workspaceId: string,
  triagedCommentId: string,
  message: string
): Promise<TriageActionResult> {
  const comment = await prisma.triagedComment.findFirst({
    where: { id: triagedCommentId, workspaceId },
    include: { instagramAccount: true },
  });
  if (!comment) return { success: false, error: "Comment not found" };
  if (!comment.instagramAccount) {
    return { success: false, error: "No Instagram account on this comment" };
  }

  const accessToken = decryptToken(comment.instagramAccount.accessToken);
  try {
    await sendCommentReply(accessToken, comment.commentId, message);
  } catch (error) {
    return { success: false, error: formatMetaError(error) };
  }

  await prisma.triagedComment.update({
    where: { id: triagedCommentId },
    data: { status: "HANDLED", repliedText: message, handledAt: new Date() },
  });

  return { success: true };
}

export async function dismissTriagedComment(
  workspaceId: string,
  triagedCommentId: string
): Promise<TriageActionResult> {
  const comment = await prisma.triagedComment.findFirst({
    where: { id: triagedCommentId, workspaceId },
    select: { id: true },
  });
  if (!comment) return { success: false, error: "Comment not found" };

  await prisma.triagedComment.update({
    where: { id: triagedCommentId },
    data: { status: "DISMISSED", handledAt: new Date() },
  });

  return { success: true };
}
