/**
 * Comment triage ingestion sweep.
 *
 * Runs independently of comment-reconciler.ts. It re-fetches the same recent
 * comments via the same read-only Graph API functions, but shares no state or
 * control flow with the DM-automation dedup/retry pipeline — that pipeline
 * has hard-won, heavily-commented dedup/retry semantics for DM sending, and
 * intertwining a second, differently-scoped concern into it risks breaking
 * that logic. Calling the same read-only API function twice per sweep is a
 * small, safe duplication; sharing control flow with a fragile pipeline is
 * not.
 *
 * commentId is @unique on TriagedComment, so a comment already stored is
 * simply skipped — this makes every sweep idempotent and is also what keeps
 * classification cached forever: once a row exists, it is never re-sent to
 * the LLM.
 */

import { prisma } from "@/lib/db/client";
import { getRecentMediaComments, getUserMedia, type InstagramMedia } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { matchesAnyAutomation, type AutomationScope } from "./keyword-scope";
import { classifyComments, type ClassificationLabel } from "./classify";

const LOOKBACK_HOURS = Number(process.env.TRIAGE_LOOKBACK_HOURS ?? 168);
const RECENT_MEDIA_LIMIT = 25;

type Classification = ClassificationLabel | "KEYWORD_MATCH";

interface TriageAccount {
  id: string;
  workspaceId: string;
  instagramId: string;
  accessToken: string;
  automations: AutomationScope[];
}

export async function sweepTriageComments(): Promise<void> {
  const accounts: TriageAccount[] = await prisma.instagramAccount.findMany({
    select: {
      id: true,
      workspaceId: true,
      instagramId: true,
      accessToken: true,
      automations: {
        where: { isActive: true },
        select: {
          id: true,
          postId: true,
          matchAnyPost: true,
          matchAnyWord: true,
          keywords: true,
          wholeWordMatch: true,
        },
      },
    },
  });

  const sinceMs = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;

  for (const account of accounts) {
    await sweepAccount(account, sinceMs).catch((error) => {
      console.error(
        `[Triage] Sweep failed for account ${account.instagramId}:`,
        error instanceof Error ? error.message : error
      );
    });
  }
}

async function sweepAccount(account: TriageAccount, sinceMs: number): Promise<void> {
  const accessToken = decryptToken(account.accessToken);

  const media = await getUserMedia(accessToken, RECENT_MEDIA_LIMIT);

  for (const post of media) {
    await sweepMedia(account, accessToken, post, sinceMs).catch((error) => {
      console.error(
        `[Triage] Sweep failed for media ${post.id} (account ${account.instagramId}):`,
        error instanceof Error ? error.message : error
      );
    });
  }
}

async function sweepMedia(
  account: TriageAccount,
  accessToken: string,
  post: InstagramMedia,
  sinceMs: number
): Promise<void> {
  const comments = await getRecentMediaComments(accessToken, post.id, sinceMs);
  if (comments.length === 0) return;

  const existing = await prisma.triagedComment.findMany({
    where: { commentId: { in: comments.map((c) => c.id) } },
    select: { commentId: true },
  });
  const existingIds = new Set(existing.map((e) => e.commentId));
  const fresh = comments.filter((c) => !existingIds.has(c.id));

  const keywordHitIds = new Set(
    fresh
      .filter((c) => matchesAnyAutomation(account.automations, post.id, c.text ?? ""))
      .map((c) => c.id)
  );

  const needsClassification = fresh
    .filter((c) => !keywordHitIds.has(c.id))
    .map((c) => ({
      commentId: c.id,
      text: c.text ?? "",
      mediaCaption: post.caption ?? null,
    }));
  const classifications = await classifyComments(needsClassification);

  for (const comment of fresh) {
    const classification: Classification | undefined = keywordHitIds.has(comment.id)
      ? "KEYWORD_MATCH"
      : classifications.get(comment.id);
    if (!classification) continue; // LLM failed to classify — retry next sweep

    await prisma.triagedComment
      .create({
        data: {
          workspaceId: account.workspaceId,
          instagramAccountId: account.id,
          mediaId: post.id,
          mediaThumbnailUrl: post.thumbnail_url ?? post.media_url ?? null,
          mediaCaption: post.caption ?? null,
          commentId: comment.id,
          authorUsername: comment.from?.username ?? null,
          text: comment.text ?? "",
          createdAt: new Date(comment.timestamp),
          classification,
        },
      })
      .catch(() => {}); // unique constraint race with a concurrent sweep — harmless
  }
}
