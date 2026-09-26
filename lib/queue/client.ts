/**
 * BullMQ Queue Client
 *
 * Provides the DM processing queue and Redis connection for BullMQ.
 */

import { Queue } from "bullmq";
import Redis, { type RedisOptions } from "ioredis";

/**
 * REDIS_URL → ioredis options via WHATWG URL. Passing ioredis the raw string makes it
 * call the deprecated url.parse() (DEP0169 on every webhook in Vercel logs).
 */
export function redisOptions(url = process.env.REDIS_URL!): RedisOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    tls: u.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null, // Required by BullMQ
  };
}

let connection: Redis | null = null;

export function getRedisConnection(): Redis {
  if (!connection) {
    connection = new Redis(redisOptions());
  }
  return connection;
}

// ─── DM Queue ───────────────────────────────────────────────────────────────────

/**
 * Job priority. BullMQ treats LOWER as more urgent.
 *
 * Measured 2026-08-26 on a live reel: median wait from comment to DM was 33 minutes,
 * 27% waited over two hours, the worst 12 hours — and three people commented "ماوصل شي"
 * after waiting 170, 218 and 239 minutes. The send rate is capped by what Meta tolerates,
 * so the queue cannot simply run faster. What it can do is serve the person who just
 * commented before the backlog from three hours ago.
 *
 * A webhook means someone is on the post RIGHT NOW. The sweep is a safety net for
 * comments already missed once — by definition nobody is watching for those.
 */
export const PRIORITY_LIVE = 1;
export const PRIORITY_BACKLOG = 10;

export type CommentSource = "WEBHOOK" | "POLLING";

export interface ProcessCommentJob {
  accountConnectionId?: string;
  instagramAccountId: string;
  commentId: string;
  commentText: string;
  commenterId: string;
  commenterName?: string;
  mediaId: string;
  // Set when the comment came from an ad: the organic post the ad was made
  // from. Campaigns are bound to that post, so both ids have to be matched.
  originalMediaId?: string;
  requeueAttempt?: number;
  // Which path enqueued this comment. It is not copied to ProcessedComment or
  // used for reconciliation dedup.
  source?: CommentSource;
}

// Delivered when a user taps an opening DM's button — carries the reveal target.
export interface ProcessPostbackJob {
  accountConnectionId?: string;
  instagramAccountId: string;
  userId: string;
  payload: string;
  mid?: string;
  fallback?: boolean;
}

// Scheduled after the link is delivered, to send the appreciation follow-up.
// Enqueued with a delay (followUpDelayMinutes) so it can fire later, not just
// immediately.
export interface ProcessFollowUpJob {
  accountConnectionId?: string;
  instagramAccountId: string;
  userId: string;
  automationId: string;
  commenterName?: string | null;
}

// An inbound DM from a user. Campaigns with `dmTriggerEnabled` whose keywords
// match the text reply to the sender.
export interface ProcessMessageJob {
  accountConnectionId?: string;
  instagramAccountId: string;
  messageId: string;
  messageText: string;
  senderId: string;
}

export type DmQueueJob =
  | ProcessCommentJob
  | ProcessPostbackJob
  | ProcessFollowUpJob
  | ProcessMessageJob;

export const POSTBACK_JOB_NAME = "process-postback";
export const FOLLOWUP_JOB_NAME = "process-followup";
export const MESSAGE_JOB_NAME = "process-message";

let dmQueue: Queue<DmQueueJob> | null = null;

export function getDMQueue(): Queue<DmQueueJob> {
  if (!dmQueue) {
    dmQueue = new Queue<DmQueueJob>("dm-processing", {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 1000 }, // Keep last 1000 completed jobs
        // Clear failed jobs shortly after they exhaust retries. Job ids are
        // deterministic (comment_<acct>_<id>), so a retained failed job would
        // block the polling reconciler from ever retrying that comment. Clearing
        // them lets a later sweep re-enqueue and try again once a transient
        // failure (e.g. an Instagram rate-limit window) has passed. Failure
        // detail is still preserved in DmLog.
        removeOnFail: { age: 300, count: 2000 },
        attempts: 3,
        backoff: {
          type: "custom",
        },
      },
    });
  }
  return dmQueue;
}
