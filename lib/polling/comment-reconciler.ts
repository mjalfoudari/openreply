/**
 * Comment reconciliation (polling safety net).
 *
 * Instagram webhooks are best-effort and never fire for a large class of
 * comments (collapsed "load more" comments, non-follower / low-signal accounts,
 * anything Instagram filters). Those comments are otherwise invisible: never
 * replied to, never DM'd.
 *
 * This sweep is deliberately narrow. For each active campaign it looks only at
 * that campaign's post, only at recent comments, and acts on a comment ONLY when
 * both are true:
 *   1. the comment matches the campaign keyword, and
 *   2. the account owner has not already replied to it.
 * The reply check reads the comment's actual replies on Instagram, so a comment
 * you (or the tool) already answered is skipped — the poll never re-touches
 * handled comments. Each sweep is capped so it can never flood the comment API
 * (which Instagram rate-limits aggressively, error 368).
 *
 * It runs on an interval in the worker process because Vercel's free crons only
 * fire once a day. Matching and sending reuse the worker's processComment, so
 * rate limiting and logging behave exactly as for webhook-delivered comments.
 *
 * Known limitation, handled not fixed: comments removed by Instagram's Hidden
 * Words / spam filter may not be returned by the Graph API at all. Disable that
 * filter on the account to widen results.
 */

import { prisma } from "@/lib/db/client";
import { PRIORITY_BACKLOG, getDMQueue } from "@/lib/queue/client";
import {
  getRecentMediaComments,
  getUserMedia,
  MetaApiError,
  type InstagramComment,
} from "@/lib/instagram/provider";
import {
  createInstagramContext,
  type InstagramContext,
} from "@/lib/instagram/provider";
import { matchKeywords } from "@/lib/utils/keyword-matcher";

// Match Instagram's own private-reply window: 7 days from the comment. Older
// than that and the send fails, so there is nothing to gain by looking further
// back — but anything shorter silently abandons commenters we could still
// legally answer. 72h used to be the default and stranded 4 usable days.
const LOOKBACK_HOURS = Number(process.env.COMMENT_POLL_LOOKBACK_HOURS ?? 168);
// Hard cap on how many new comments a single campaign can enqueue per sweep, so
// a viral post drains gradually instead of bursting into the comment API.
const MAX_NEW_PER_SWEEP = Number(process.env.COMMENT_POLL_MAX_PER_SWEEP ?? 30);
// For "any post" campaigns, how many recent posts to scan.
const RECENT_MEDIA_LIMIT = 10;

interface SweepStat {
  campaign: string;
  keywords: string;
  matched: number;
  alreadyReplied: number;
  enqueued: number;
  /** People this sweep saw, could have messaged, and ran out of budget for. */
  truncated: number;
  /** Comments Instagram would not name an author for. */
  anonymised: number;
  errors: string[];
}

function errMessage(error: unknown): string {
  if (error instanceof MetaApiError)
    return `Meta ${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

/** One reconciliation pass across every active campaign. */
export async function reconcileComments(): Promise<void> {
  const automations = await prisma.automation.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      postId: true,
      matchAnyPost: true,
      matchAnyWord: true,
      keywords: true,
      wholeWordMatch: true,
      publicReplyEnabled: true,
      workspaceId: true,
      instagramAccount: {
        select: {
          id: true,
          instagramId: true,
          username: true,
          accessToken: true,
          provider: true,
          workspaceId: true,
          zernioAccountId: true,
        },
      },
    },
  });

  const sinceMs = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
  const tokenCache = new Map<string, InstagramContext | null>();

  for (const automation of automations) {
    const stat = await sweepCampaign({
      automation: automation,
      sinceMs: sinceMs,
      tokenCache: tokenCache,
    }).catch(
      (error): SweepStat => ({
        campaign: automation.name,
        keywords: automation.keywords.join(","),
        matched: 0,
        alreadyReplied: 0,
        enqueued: 0,
        truncated: 0,
        anonymised: 0,
        errors: [errMessage(error)],
      })
    );
    await recordSweep(automation.workspaceId, stat);
  }
}

async function sweepCampaign({
  automation,
  sinceMs,
  tokenCache,
}: {
  automation: {
    id: string;
    name: string;
    workspaceId: string;
    postId: string | null;
    matchAnyPost: boolean;
    matchAnyWord: boolean;
    keywords: string[];
    wholeWordMatch: boolean;
    publicReplyEnabled: boolean;
    instagramAccount: {
      id: string;
      instagramId: string;
      username: string;
      accessToken: string;
      provider: "META" | "ZERNIO";
      workspaceId: string;
      zernioAccountId: string | null;
    };
  };
  sinceMs: number;
  tokenCache: Map<string, InstagramContext | null>;
}): Promise<SweepStat> {
  const account = automation.instagramAccount;
  const stat: SweepStat = {
    campaign: automation.name,
    keywords: automation.matchAnyWord
      ? "(any word)"
      : automation.keywords.join(","),
    matched: 0,
    alreadyReplied: 0,
    enqueued: 0,
    truncated: 0,
    anonymised: 0,
    errors: [],
  };

  // Decrypt the account token once per sweep.
  let accessToken = tokenCache.get(account.id);
  if (accessToken === undefined) {
    try {
      accessToken = await createInstagramContext(account);
    } catch {
      accessToken = null;
    }
    tokenCache.set(account.id, accessToken);
  }
  if (!accessToken) {
    stat.errors.push("Failed to decrypt access token");
    return stat;
  }

  // Which media this campaign covers: its own post, or the recent feed if it
  // matches any post.
  const mediaIds: string[] = [];
  if (automation.postId) {
    mediaIds.push(automation.postId);
    mediaIds.push(...(await adMediaFor(automation.postId)));
  } else if (automation.matchAnyPost) {
    try {
      const media = await getUserMedia({
        context: accessToken,
        limit: RECENT_MEDIA_LIMIT,
      });
      mediaIds.push(...media.map((m) => m.id));
    } catch (error) {
      stat.errors.push(`Media list: ${errMessage(error)}`);
    }
  }
  if (mediaIds.length === 0) return stat;

  const queue = getDMQueue();

  for (const mediaId of mediaIds) {
    let comments: InstagramComment[];
    try {
      comments = await getRecentMediaComments({
        context: accessToken,
        mediaId: mediaId,
        sinceMs: sinceMs,
      });
    } catch (error) {
      stat.errors.push(`Comments ${mediaId}: ${errMessage(error)}`);
      continue;
    }

    // Keep only comments that (a) aren't the account's own, (b) match the
    // keyword, and (c) have no reply from the account owner yet.
    let anonymised = 0;
    const needsAction = comments.filter((c) => {
      const authorId = c.from?.id;
      // graph.instagram.com omits `from` for accounts the app cannot resolve — which is
      // the same restricted, low-signal population webhooks already miss. Dropping them
      // here cost 32 people permanently. The private reply does not need an author id at
      // all: it targets recipient:{comment_id}. Only the NOT NULL commenterId column does.
      if (authorId === account.instagramId) return false;
      if (!authorId) anonymised += 1;

      const matched = automation.matchAnyWord
        ? true
        : matchKeywords(
            c.text ?? "",
            automation.keywords,
            automation.wholeWordMatch
          ).matched;
      if (!matched) return false;
      stat.matched += 1;

      const ownerReplied = (c.replies?.data ?? []).some(
        (r) => r.from?.id === account.instagramId
      );
      if (ownerReplied) {
        stat.alreadyReplied += 1;
        return false;
      }
      return true;
    });
    if (needsAction.length === 0) continue;

    // Second guard against races: skip comments this campaign has already fully
    // handled. "Fully handled" depends on the campaign: if it posts a public
    // reply, the completion signal is publicReplySentAt (a DM alone is not
    // enough — the reply still has to land); otherwise a SENT DM is enough. This
    // is what lets a comment whose DM sent but whose public reply failed come
    // back and retry the reply.
    const handled = await prisma.dmLog.findMany({
      where: {
        automationId: automation.id,
        commentId: { in: needsAction.map((c) => c.id) },
        OR: [
          { status: "SKIPPED_DEDUP" },
          { status: "SKIPPED_PLAN_LIMIT" },
          { dmDeliveryUnconfirmed: true },
          { status: "FAILED", attempts: { gte: 3 } },
          {
            status: "SENT",
            ...(automation.publicReplyEnabled ? {
              OR: [{ publicReplySentAt: { not: null } }, { publicReplyDeliveryUnconfirmed: true }],
            } : {}),
          },
        ],
      },
      select: { commentId: true },
    });
    const handledSet = new Set(handled.map((h) => h.commentId));

    // One DM per person per campaign, not per comment. Dedup is keyed on
    // (automationId, commentId), so someone who writes "مهتم" three times used to
    // get three identical DMs — and a second keyword on the same campaign
    // (مهتم + مهام) counted as another. Drop anyone this campaign has already
    // reached, then keep only their earliest unanswered comment.
    const candidates = needsAction
      .filter((c) => !handledSet.has(c.id))
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

    const alreadyMessaged = new Set(
      (
        await prisma.dmLog.findMany({
          where: {
            automationId: automation.id,
            status: "SENT",
            commenterId: { in: candidates.map((c) => c.from?.id ?? `anon_${c.id}`) },
          },
          select: { commenterId: true },
        })
      ).map((l) => l.commenterId)
    );

    const seenThisSweep = new Set<string>();
    const skipped: InstagramComment[] = [];
    const fresh = candidates
      .filter((c) => {
        const who = c.from?.id ?? `anon_${c.id}`;
        if (alreadyMessaged.has(who)) {
          // Proven SENT for this person — a real decision, worth writing down.
          stat.alreadyReplied += 1;
          skipped.push(c);
          return false;
        }
        if (seenThisSweep.has(who)) {
          // Same person twice in ONE sweep. Their earliest comment is being enqueued
          // right now and has not landed yet, so this is not a decision — it is a
          // guess. Writing SKIPPED_DEDUP here made the later comments terminal before
          // the first DM was even attempted, and every comment id carries its own
          // private-reply allowance, so a failed first send burned the spares too.
          // Leave it a candidate; the next sweep judges it against a real outcome.
          stat.alreadyReplied += 1;
          return false;
        }
        seenThisSweep.add(who);
        return true;
      })
      .slice(0, MAX_NEW_PER_SWEEP);
    stat.truncated = candidates.length - fresh.length - skipped.length;
    stat.anonymised = anonymised;

    // Write the skip down so the next sweep can see it was a decision.
    for (const c of skipped) {
      await prisma.dmLog
        .upsert({
          where: { automationId_commentId: { automationId: automation.id, commentId: c.id } },
          create: {
            workspaceId: automation.workspaceId,
            automationId: automation.id,
            instagramAccountId: account.id,
            commenterId: c.from?.id ?? `anon_${c.id}`,
            commenterName: c.from?.username,
            commentText: c.text ?? "",
            commentId: c.id,
            status: "SKIPPED_DEDUP",
            errorMessage: "Already messaged this person for this campaign",
          },
          update: {},
        })
        .catch(() => {});
    }

    for (const c of fresh) {
      // Deterministic jobId + removeOnComplete: while a comment is still queued
      // it cannot be queued again, and the moment it finishes the id frees up so
      // a genuine retry is never blocked.
      //
      // Without this the sweep and the send rate fight each other: the sweep re-adds
      // anything not yet marked handled every 5 minutes, the worker's limiter drains
      // slower than that, and the queue inflates with copies of the same comment.
      // Observed 2026-08-26: 537 queued jobs for 153 real comments, one comment
      // queued 17 times. Harmless to recipients (the worker is idempotent) but new
      // comments wait behind hundreds of duplicates.
      await queue.add("process-comment", {
        instagramAccountId: account.instagramId,
        accountConnectionId: account.id,
        commentId: c.id,
        commentText: c.text ?? "",
        commenterId: c.from?.id ?? `anon_${c.id}`,
        commenterName: c.from?.username,
        mediaId,
        // When the sweep is looking at an ad, the campaign is bound to the post
        // the ad was made from: without this the worker matches nothing and
        // drops the comment, so the sweep would enqueue it again every five
        // minutes and never deliver it.
        originalMediaId:
          automation.postId && mediaId !== automation.postId
            ? automation.postId
            : undefined,
        source: "POLLING",
      }, {
        jobId: `c_${automation.id}_${c.id}`,
        removeOnComplete: true,
        // Behind anything the webhook just delivered: these were already missed once,
        // so nobody is staring at the post waiting for them.
        priority: PRIORITY_BACKLOG,
      });
      stat.enqueued += 1;
    }
  }

  return stat;
}

/**
 * Ad copies of a post, as seen in webhooks already received.
 *
 * Boosting a post gives it a second media id: comments left on the ad arrive
 * with the ad's `media.id` and the post's id in `original_media_id`. The sweep
 * would otherwise only ever look at the post itself, so a comment Meta fails to
 * deliver on the ad is lost for good — exactly the case this safety net exists
 * for, and the one where volume is highest.
 *
 * The ad ids are recovered from the webhooks themselves rather than from the
 * ads API, which would need ads_management on top of the permissions the app
 * already asks for. The trade-off: an ad becomes visible to the sweep only once
 * a single comment on it has arrived. That is enough for the failure being
 * covered here, where some webhooks arrive and others do not.
 */
export async function adMediaFor(postId: string): Promise<string[]> {
  try {
    const rows = await prisma.$queryRaw<{ mediaId: string | null }[]>`
      SELECT DISTINCT change->'value'->'media'->>'id' AS "mediaId"
      FROM "WebhookEvent" w,
           jsonb_array_elements(w.payload::jsonb->'entry') entry,
           jsonb_array_elements(entry->'changes') change
      WHERE change->>'field' = 'comments'
        AND change->'value'->'media'->>'original_media_id' = ${postId}
        AND w."createdAt" > now() - interval '90 days'
    `;
    return rows
      .map((r) => r.mediaId)
      .filter((id): id is string => Boolean(id) && id !== postId);
  } catch {
    // A failure here must not stop the sweep: the post itself is still checked.
    return [];
  }
}

async function recordSweep(
  workspaceId: string,
  stat: SweepStat
): Promise<void> {
  // Only log when something happened or something went wrong.
  if (stat.enqueued === 0 && stat.errors.length === 0 && stat.truncated === 0) return;

  await prisma.operationalEvent
    .create({
      data: {
        workspaceId,
        source: "SYSTEM",
        // Leaving people behind is not INFO. The old log said "30 enqueued, 95 matched"
        // at INFO while 65 people waited, which is indistinguishable from a healthy sweep.
        level: stat.errors.length > 0 || stat.truncated > 0 ? "WARNING" : "INFO",
        message:
          `Comment sweep "${stat.campaign}" [${stat.keywords}]: ${stat.enqueued} enqueued, ` +
          `${stat.matched} matched, ${stat.alreadyReplied} already replied` +
          (stat.truncated > 0 ? `, ${stat.truncated} LEFT BEHIND (budget)` : "") +
          (stat.anonymised > 0 ? `, ${stat.anonymised} with no author id` : ""),
        payload: { ...stat },
      },
    })
    .catch(() => {});
}
