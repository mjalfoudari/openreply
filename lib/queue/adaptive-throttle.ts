/**
 * Adaptive send throttle.
 *
 * On 2026-08-26 the account sustained ~180 private replies/hour and Meta began refusing
 * 26% of them — reported not as a rate-limit code but as
 * "the thread owner archived or deleted this conversation", which reads like a per-user
 * problem and is not one. 145 people got nothing over two hours. The failures cleared on
 * their own once volume fell, which is what a decaying account-level throttle looks like.
 *
 * The fixed limiter could not see any of that: it spaces jobs at a rate chosen in advance
 * and keeps spacing them at that rate while every send fails. This watches the outcomes and
 * slows down on its own.
 *
 * Deliberately in-memory. The worker is a singleton (Redis lock in worker/dm-worker.ts), so
 * there is one writer, and starting fresh after a restart is the right default — a restart
 * is exactly when the previous throttle state is least likely to still be true.
 */

import { prisma } from "@/lib/db/client";

/** Outcomes considered when judging health. Older ones fall off the end. */
const WINDOW = 40;
/** Failure share that trips the brake. Below TRIP but above CLEAR, the current level holds. */
const TRIP = 0.15;
/** Failure share that starts the recovery. */
const CLEAR = 0.05;
/** Extra pause per level, before each send. Level 0 adds nothing. */
const STEP_MS = 5_000;
/**
 * Ceiling on the brake. Was 6 (+30s per send); on 2026-08-26 the throttle sat pinned
 * at 6 while still failing 90%, which is a brake that has run out of travel. 12 lets it
 * fall to roughly one send a minute before giving up on slowing down.
 */
const MAX_LEVEL = 12;
/** Judge only on a meaningful sample, or a single early failure trips everything. */
const MIN_SAMPLE = 10;

/**
 * Errors that mean "you are going too fast" or "this account is being restricted", as
 * opposed to "this particular recipient cannot be reached". Only the former should slow
 * the whole queue down: a deleted comment or a vanished user says nothing about our rate,
 * and letting those trip the brake would throttle the account for one bad recipient.
 */
const THROTTLE_SIGNATURES = [
  "مالك سلسلة الرسائل",              // thread archived/deleted — what the incident surfaced as
  "archived",
  "rate limit",
  "too many",
  "temporarily blocked",
  "Please retry your request later",
  "An unexpected error has occurred",  // Meta error 2, seen at the tail of bursts
];

/** Errors that are about one recipient and must NOT slow anyone else down. */
const PER_RECIPIENT_SIGNATURES = [
  "لا يمكن العثور على المستخدم",     // user not found
  "does not exist",                   // comment deleted
  "invalid for a private reply",
];

/**
 * True when the failure is about this one recipient and no retry will change it —
 * their account is gone, restricted, or unreachable. Distinct from a transient
 * failure: these people are not waiting in a queue, and counting them as owed
 * forever makes a permanent floor look like an unresolved backlog.
 */
export function isPerRecipientFailure(message: string): boolean {
  return PER_RECIPIENT_SIGNATURES.some((s) => message.includes(s));
}

export function isThrottleSignal(message: string): boolean {
  if (PER_RECIPIENT_SIGNATURES.some((s) => message.includes(s))) return false;
  return THROTTLE_SIGNATURES.some((s) => message.toLowerCase().includes(s.toLowerCase()));
}

const outcomes: boolean[] = [];
let level = 0;

function failureRate(): number {
  if (outcomes.length < MIN_SAMPLE) return 0;
  return outcomes.filter((ok) => !ok).length / outcomes.length;
}

async function note(message: string, level_: "INFO" | "WARNING") {
  console.log(`[throttle] ${message}`);
  await prisma.operationalEvent
    .create({ data: { source: "WORKER", level: level_, message: `[throttle] ${message}` } })
    .catch(() => {});
}

/** Record the outcome of one send attempt. `error` is the raw message, if it failed. */
export function record(ok: boolean, error?: string): void {
  // A per-recipient failure is not evidence about our rate, so it is not evidence at all.
  if (!ok && error && !isThrottleSignal(error)) return;

  outcomes.push(ok);
  if (outcomes.length > WINDOW) outcomes.shift();

  const rate = failureRate();
  if (rate >= TRIP && level < MAX_LEVEL) {
    level += 1;
    outcomes.length = 0; // judge the new pace on its own results, not the old ones
    void note(
      `failure rate ${(rate * 100).toFixed(0)}% — slowing to level ${level} (+${(level * STEP_MS) / 1000}s per send)`,
      "WARNING"
    );
  } else if (rate <= CLEAR && level > 0 && outcomes.length >= WINDOW) {
    level -= 1;
    outcomes.length = 0;
    void note(
      `recovered to level ${level} (+${(level * STEP_MS) / 1000}s per send)`,
      "INFO"
    );
  }
}

/** Await before a send. Resolves immediately while healthy. */
export async function gate(): Promise<void> {
  if (level === 0) return;
  await new Promise((r) => setTimeout(r, level * STEP_MS));
}

export function state(): { level: number; failureRate: number; sample: number } {
  return { level, failureRate: failureRate(), sample: outcomes.length };
}

/** Testing only. */
export function __reset(): void {
  outcomes.length = 0;
  level = 0;
}
