/**
 * Delivery health check. Run every 15 minutes.
 *
 * Every failure this system has had was invisible while it was happening:
 *  - the Arabic matcher matched nothing for days, and the sweep logs nothing when it
 *    matches nothing, so a dead campaign looked identical to a quiet one
 *  - two workers ran for hours, doubling the send rate
 *  - a retry loop sent one person five copies while logging FAILED each time
 *  - a landed public reply retired 178 people whose DM had failed
 *  - Meta refused 26% of sends for ninety minutes
 *
 * None of them announced themselves. Each was found hours later by someone going
 * looking. This goes looking on a timer and writes what it finds to OperationalEvent,
 * so /diagnostics shows it.
 */
import { prisma } from "@/lib/db/client";
import { getDMQueue } from "@/lib/queue/client";
import { getRecentMediaComments } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import { isPerRecipientFailure } from "@/lib/queue/adaptive-throttle";

type Level = "INFO" | "WARNING" | "ERROR";
const found: { level: Level; message: string }[] = [];
const flag = (level: Level, message: string) => found.push({ level, message });

const MIN = 60_000;

async function main() {
  const now = Date.now();

  // 1. Is the sender even alive? A stopped worker is silent by nature.
  const lastSend = await prisma.dmLog.findFirst({
    where: { status: "SENT" }, orderBy: { dmSentAt: "desc" }, select: { dmSentAt: true },
  });
  const queue = await getDMQueue().getJobCounts("waiting", "active", "failed");
  if (queue.waiting > 0 && lastSend?.dmSentAt) {
    const idleMin = (now - lastSend.dmSentAt.getTime()) / MIN;
    if (idleMin > 20) {
      flag("ERROR", `queue has ${queue.waiting} waiting but nothing has sent for ${idleMin.toFixed(0)} min — worker stopped or blocked`);
    }
  }

  // 1b. More than one worker. Two instances double the send rate and split the throttle's
  //     view of failures between two private windows, so neither brake can hold the line.
  //     It has happened twice; both times it was invisible for hours.
  try {
    const { getRedisConnection } = await import("@/lib/queue/client");
    const alive = await getRedisConnection().keys("openreply:worker:alive:*");
    if (alive.length > 1) {
      flag("ERROR", `${alive.length} workers are alive at once (${alive.map((k) => k.split(":").pop()).join(", ")}) — they double the send rate and blind the throttle`);
    } else if (alive.length === 0 && queue.waiting > 0) {
      flag("ERROR", `no worker heartbeat, ${queue.waiting} jobs waiting`);
    }
  } catch { /* redis unavailable — the other checks still run */ }

  // 2. Send failure rate. This is the check that would have caught the 26% refusal in
  //    minutes instead of ninety.
  const recent = await prisma.dmLog.findMany({
    where: { updatedAt: { gte: new Date(now - 30 * MIN) } },
    select: { status: true, errorMessage: true },
  });
  // A SENT row that still carries an errorMessage is dm-worker's "Meta errored but the
  // conversations API proves it landed" case. The person is served, so it must NOT go on
  // the owed list below — but Meta DID refuse, so it must still count here or this alarm
  // goes quiet during exactly the 26%-refusal event it exists to catch.
  const errored = (r: { status: string; errorMessage: string | null }) =>
    r.status === "FAILED" || (r.status === "SENT" && r.errorMessage !== null);
  const sent = recent.filter((r) => r.status === "SENT" && !r.errorMessage).length;
  const failed = recent.filter(errored).length;
  if (sent + failed >= 10) {
    const rate = failed / (sent + failed);
    if (rate >= 0.1) {
      const top = Object.entries(
        recent.filter(errored)
          .reduce<Record<string, number>>((a, r) => {
            const k = (r.errorMessage ?? "").slice(0, 45); a[k] = (a[k] ?? 0) + 1; return a;
          }, {})
      ).sort((a, b) => b[1] - a[1])[0];
      flag("WARNING", `send failure rate ${(rate * 100).toFixed(0)}% over 30 min (${failed}/${sent + failed}); most common: ${top?.[0]}`);
    }
  }

  // 3. People who asked and have nothing — the number that actually matters.
  //
  // Split by whether we can still do something about it. On 2026-08-27 this line read
  // "32 people have never received anything" for hours while the queue was empty and
  // healthy: every one of them was an unreachable account. A permanent floor reported
  // as an open backlog is the same failure mode as an error string that names the wrong
  // cause — it invites you to go looking for a problem that is not there.
  const failedRows = await prisma.dmLog.findMany({
    where: { status: "FAILED", createdAt: { gte: new Date(now - 7 * 24 * 60 * MIN) } },
    select: { commenterId: true, attempts: true, errorMessage: true },
  });
  const everSent = new Set(
    (await prisma.dmLog.findMany({ where: { status: "SENT" }, select: { commenterId: true } }))
      .map((r) => r.commenterId)
  );
  const allOwed = failedRows.filter((r) => !everSent.has(r.commenterId));
  const unreachable = allOwed.filter((r) => isPerRecipientFailure(r.errorMessage ?? ""));
  const owed = allOwed.filter((r) => !isPerRecipientFailure(r.errorMessage ?? ""));
  const stuck = owed.filter((r) => (r.attempts ?? 0) >= 3);
  if (owed.length > 0) {
    flag(stuck.length > 0 ? "WARNING" : "INFO",
      `${owed.length} people inside the 7-day window are still waiting (${stuck.length} exhausted their retries); ${unreachable.length} more are unreachable accounts, nothing to do`);
  } else if (unreachable.length > 0) {
    flag("INFO", `nobody is waiting; ${unreachable.length} unreachable accounts in the window (deleted, restricted, or blocking us)`);
  }

  // 4. A live campaign that matches nothing. This is the Arabic-matcher class: the
  //    campaign is LIVE, comments arrive, and it silently produces zero.
  const autos = await prisma.automation.findMany({
    where: { isActive: true, postId: { not: null } },
    select: { id: true, name: true, postId: true, keywords: true, matchAnyWord: true,
              wholeWordMatch: true, instagramAccount: { select: { instagramId: true, accessToken: true } } },
  });
  for (const a of autos) {
    let token: string;
    try { token = decryptToken(a.instagramAccount.accessToken); } catch { continue; }
    let comments;
    try { comments = await getRecentMediaComments(token, a.postId!, now - 2 * 60 * MIN); }
    catch { continue; }
    const theirs = comments.filter((c) => c.from?.id !== a.instagramAccount.instagramId);
    if (theirs.length < 5) continue;                     // too quiet to judge
    const matched = theirs.filter((c) =>
      a.matchAnyWord || matchKeywords(c.text ?? "", a.keywords, a.wholeWordMatch).matched);
    if (matched.length === 0) {
      flag("WARNING", `"${a.name}" took ${theirs.length} comments in 2h and matched ZERO — check the keyword gate`);
      continue;
    }
    const logged = await prisma.dmLog.count({
      where: { automationId: a.id, commentId: { in: matched.map((c) => c.id) } },
    });
    if (logged < matched.length) {
      flag("WARNING", `"${a.name}": ${matched.length - logged} matching comments have no DmLog row at all`);
    }
  }

  // 5. The queue eating itself.
  if (queue.waiting > 300) flag("WARNING", `queue backlog ${queue.waiting} waiting`);

  const level: Level = found.some((f) => f.level === "ERROR") ? "ERROR"
    : found.some((f) => f.level === "WARNING") ? "WARNING" : "INFO";
  const message = found.length
    ? `[health] ${found.map((f) => f.message).join(" | ")}`
    : `[health] ok — ${sent} sent / ${failed} failed in 30 min, ${queue.waiting} queued`;

  console.log(new Date().toISOString(), message);
  // Only persist something worth waking up for; a green run every 15 minutes is noise.
  if (level !== "INFO") {
    await prisma.operationalEvent.create({ data: { source: "HEALTH", level, message } }).catch(() => {});
  }
  process.exit(0);
}

void main();
