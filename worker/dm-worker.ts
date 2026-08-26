import { createDMWorker } from "@/lib/queue/dm-worker";
import { recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import { reconcileComments } from "@/lib/polling/comment-reconciler";
import { getRedisConnection } from "@/lib/queue/client";
import { execSync } from "node:child_process";
import os from "node:os";

// ─── Single-instance guard ──────────────────────────────────────────────────
//
// Nothing stopped two workers running at once, and on 2026-08-26 two were: each
// swept every 5 minutes, each enqueued the same comments, and the account sent at
// double the intended rate. Orphaned instances are easy to create — killing the
// npm parent leaves the tsx child reparented to init and still sweeping.
//
// The lock lives in Redis (already required for BullMQ), so it holds across
// machines, not just across processes on this laptop. It is refreshed on every
// heartbeat and released on clean shutdown; if a worker is SIGKILLed the TTL
// clears it within 90s.
const LOCK_KEY = "openreply:worker:singleton";
const LOCK_TTL_MS = 90_000;
const OWNER = `${os.hostname()}:${process.pid}`;

function codeVersion(): string {
  try {
    const sha = execSync("git rev-parse --short HEAD", { cwd: process.cwd() }).toString().trim();
    const dirty = execSync("git status --porcelain lib worker", { cwd: process.cwd() }).toString().trim();
    return dirty ? `${sha}+local-edits` : sha;
  } catch {
    return "unknown";
  }
}

async function acquireLock(): Promise<boolean> {
  const redis = getRedisConnection();
  const got = await redis.set(LOCK_KEY, OWNER, "PX", LOCK_TTL_MS, "NX");
  if (got === "OK") return true;
  const holder = await redis.get(LOCK_KEY);
  console.error(
    `[DM Worker] Another worker holds the lock (${holder}). Refusing to start — ` +
      `two workers double the send rate and duplicate every sweep.`
  );
  return false;
}

async function refreshLock(): Promise<void> {
  const redis = getRedisConnection();
  // Only extend our own lock, never steal someone else's.
  const owner = await redis.get(LOCK_KEY);
  if (owner === OWNER) await redis.pexpire(LOCK_KEY, LOCK_TTL_MS);
}

async function releaseLock(): Promise<void> {
  const redis = getRedisConnection();
  const owner = await redis.get(LOCK_KEY);
  if (owner === OWNER) await redis.del(LOCK_KEY);
}

// tsx compiles this to CJS, where top-level await is unavailable — so the whole
// startup lives in start() and the lock is taken before anything else runs.
async function start() {
  if (!(await acquireLock())) {
    process.exit(0);
  }

  const VERSION = codeVersion();
  console.log(`[DM Worker] code ${VERSION} · owner ${OWNER}`);

  const worker = createDMWorker();
  const startedAt = new Date().toISOString();
  const HEARTBEAT_INTERVAL_MS = 30_000;
  // Polling safety net for comments that webhooks miss. Runs in the worker because
  // it must fire every few minutes and Vercel's free crons only run once a day.
  const POLL_INTERVAL_MS = Number(
    process.env.COMMENT_POLL_INTERVAL_MS ?? 5 * 60_000
  );

  console.log("[DM Worker] Started");

  async function heartbeat() {
    try {
      await refreshLock();
      await recordWorkerHeartbeat({
        pid: process.pid,
        hostname: os.hostname(),
        startedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[DM Worker] Heartbeat failed:", message);
    }
  }

  void heartbeat();
  const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

  async function poll() {
    try {
      await reconcileComments();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[DM Worker] Comment reconciliation failed:", message);
    }
  }

  // Kick off one sweep shortly after boot, then on a fixed interval.
  setTimeout(() => void poll(), 10_000);
  const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);

  async function shutdown(signal: string) {
    console.log(`[DM Worker] ${signal} received, closing worker`);
    clearInterval(heartbeatTimer);
    clearInterval(pollTimer);
    await worker.close();
    await releaseLock().catch(() => {});
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void start();
