/**
 * Rate Limiter
 *
 * Redis-based rate limiter for Instagram private replies.
 *
 * The cap matches Meta's documented limit for this exact call: 750 private
 * replies per hour per Instagram professional account, for comments on posts
 * and reels. Exceeding it risks 429s and app-level restrictions, so the worker
 * requeues rather than pushing through.
 * https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
 *
 * Note this is a hard ceiling with no headroom. If Meta throttles before the
 * documented limit, or other calls on the same account share the bucket, lower
 * this value.
 */

import Redis from "ioredis";

const RATE_LIMIT_MAX = 750; // private replies per hour, per Meta's documented cap
const RATE_LIMIT_WINDOW = 3600; // 1 hour in seconds

/**
 * Daily ceiling. Meta documents no such limit, but the account behaves as if one
 * exists: measured over 2026-08-20..26, every day at or under ~250 sends drew zero
 * refusals, while the day that reached ~1,380 (a backlog drain) drew repeated waves
 * of account-level soft blocks, each lasting 1-2 hours. The hourly cap cannot see
 * this — 150/hour was refused nothing in the morning and refused 90% by evening.
 *
 * 500 sits above any normal day's traffic and only bites during a backlog drain,
 * which is exactly when we get blocked. The window is rolling from the first send,
 * not a calendar day, so it cannot be reset by waiting for midnight.
 */
export const DAILY_LIMIT_MAX = 500;
const DAILY_LIMIT_WINDOW = 86400; // 24 hours in seconds
const REQUEUE_DELAY_MS = 30 * 60 * 1000; // 30 minutes
const MAX_REQUEUE_ATTEMPTS = 3;

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null, // required by BullMQ
    });
  }
  return redis;
}

export interface RateLimitResult {
  allowed: boolean;
  currentCount: number;
  remainingDMs: number;
  shouldRequeue: boolean;
  requeueDelayMs: number;
  shouldSkip: boolean;
  reserved: boolean;
}

// Returns {allowed, hourly_count, hourly_remaining, daily_retry_after}.
// daily_retry_after is 0 unless the DAILY cap is what blocked, in which case it
// carries the seconds until that window rolls over — the only honest retry delay.
const RESERVE_DM_SLOT_SCRIPT = `
local hourly = tonumber(redis.call("GET", KEYS[1]) or "0")
local daily = tonumber(redis.call("GET", KEYS[2]) or "0")
local hourly_max = tonumber(ARGV[1])
local hourly_ttl = tonumber(ARGV[2])
local daily_max = tonumber(ARGV[3])
local daily_ttl = tonumber(ARGV[4])

if daily >= daily_max then
  local left = redis.call("TTL", KEYS[2])
  if left < 0 then left = daily_ttl end
  return {0, hourly, 0, left}
end

if hourly >= hourly_max then
  return {0, hourly, 0, 0}
end

local next_count = redis.call("INCR", KEYS[1])
if next_count == 1 then
  redis.call("EXPIRE", KEYS[1], hourly_ttl)
end

local next_daily = redis.call("INCR", KEYS[2])
if next_daily == 1 then
  redis.call("EXPIRE", KEYS[2], daily_ttl)
end

return {1, next_count, hourly_max - next_count, 0}
`;

function toScriptNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseInt(value, 10);
  return 0;
}

function blockedResult(
  count: number,
  requeueAttempt: number
): RateLimitResult {
  if (requeueAttempt >= MAX_REQUEUE_ATTEMPTS) {
    return {
      allowed: false,
      currentCount: count,
      remainingDMs: 0,
      shouldRequeue: false,
      requeueDelayMs: 0,
      shouldSkip: true,
      reserved: false,
    };
  }

  return {
    allowed: false,
    currentCount: count,
    remainingDMs: 0,
    shouldRequeue: true,
    requeueDelayMs: REQUEUE_DELAY_MS,
    shouldSkip: false,
    reserved: false,
  };
}

/**
 * Check if an Instagram account is within its DM rate limit.
 *
 * Uses a Redis counter with a 1-hour TTL per account.
 * Key pattern: `rate:dm:{instagramAccountId}`
 *
 * @param instagramAccountId - The Instagram account ID to check
 * @param requeueAttempt - How many times this job has been requeued (0 = first attempt)
 * @returns Rate limit result with action recommendations
 */
export async function checkRateLimit(
  instagramAccountId: string,
  requeueAttempt: number = 0
): Promise<RateLimitResult> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;

  const currentCount = await client.get(key);
  const count = currentCount ? parseInt(currentCount, 10) : 0;

  if (count >= RATE_LIMIT_MAX) {
    // Over the limit
    if (requeueAttempt >= MAX_REQUEUE_ATTEMPTS) {
      // Exceeded max requeue attempts — skip this DM
      return {
        allowed: false,
        currentCount: count,
        remainingDMs: 0,
        shouldRequeue: false,
        requeueDelayMs: 0,
        shouldSkip: true,
        reserved: false,
      };
    }

    return {
      allowed: false,
      currentCount: count,
      remainingDMs: 0,
      shouldRequeue: true,
      requeueDelayMs: REQUEUE_DELAY_MS,
      shouldSkip: false,
      reserved: false,
    };
  }

  return {
    allowed: true,
    currentCount: count,
    remainingDMs: RATE_LIMIT_MAX - count,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: false,
  };
}

/**
 * Atomically reserve a DM send slot for an Instagram account.
 * This is the worker-safe path; it prevents concurrent jobs from all passing
 * the rate-limit check before any of them increments the Redis counter.
 */
export async function reserveDMSlot(
  instagramAccountId: string,
  requeueAttempt: number = 0
): Promise<RateLimitResult> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;
  const dailyKey = `rate:dm:daily:${instagramAccountId}`;

  const result = await client.eval(
    RESERVE_DM_SLOT_SCRIPT,
    2,
    key,
    dailyKey,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW,
    DAILY_LIMIT_MAX,
    DAILY_LIMIT_WINDOW
  );
  const values = Array.isArray(result) ? result : [];
  const allowedFlag = toScriptNumber(values[0]);
  const count = toScriptNumber(values[1]);
  const remaining = toScriptNumber(values[2]);
  const dailyRetryAfter = toScriptNumber(values[3]);

  if (allowedFlag !== 1) {
    // A daily block always requeues, however many times it has already bounced:
    // skipping would strand someone for a ceiling that lifts on its own within a
    // day, well inside Instagram's 7-day private-reply window.
    if (dailyRetryAfter > 0) {
      return {
        allowed: false,
        currentCount: count,
        remainingDMs: 0,
        shouldRequeue: true,
        requeueDelayMs: (dailyRetryAfter + 60) * 1000,
        shouldSkip: false,
        reserved: false,
      };
    }
    return blockedResult(count, requeueAttempt);
  }

  return {
    allowed: true,
    currentCount: count,
    remainingDMs: remaining,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  };
}

/**
 * Backwards-compatible helper for tests and admin scripts.
 * Prefer reserveDMSlot in workers.
 */
export async function incrementDMCounter(
  instagramAccountId: string
): Promise<number> {
  const result = await reserveDMSlot(instagramAccountId, MAX_REQUEUE_ATTEMPTS);
  return result.currentCount;
}

/**
 * Get the current DM count for an Instagram account.
 */
export async function getCurrentDMCount(
  instagramAccountId: string
): Promise<number> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;
  const count = await client.get(key);
  return count ? parseInt(count, 10) : 0;
}

/**
 * Reset the rate limiter for an account (useful for testing).
 */
export async function resetRateLimit(
  instagramAccountId: string
): Promise<void> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;
  await client.del(key);
}

// Export constants for use in tests
export { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW, REQUEUE_DELAY_MS, MAX_REQUEUE_ATTEMPTS };
