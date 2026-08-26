# Stack

Everything OpenReply needs to run, in one place: the application libraries, the
runtime processes, and the specific (free) services this instance is deployed on.
For the step-by-step setup, see [setup.md](setup.md).

## Application

| Layer | Tool |
| --- | --- |
| Framework | Next.js 16 (App Router, Turbopack) + React 19 |
| Language | TypeScript 5 |
| ORM / DB | Prisma 7 with the `@prisma/adapter-pg` driver, PostgreSQL |
| Queue | BullMQ 5 on Redis, via `ioredis` |
| Auth | Auth.js / NextAuth 5 (email magic links) |
| Email | Resend (login links) |
| Validation | Zod 4 |
| Charts | Recharts 3 |
| Styling | Tailwind CSS 4 |
| Tests | Vitest 4 |
| Worker runtime | `tsx` (runs `worker/dm-worker.ts`) |
| Instagram | Official Meta Graph API (Instagram Login) |

## Runtime — two processes, two datastores

- **Web app + API** (`npm run dev` / `npm start`): Next.js. Serves the dashboard,
  the OAuth callback, and the incoming webhook. Serverless-friendly; runs on Vercel.
- **Worker** (`npm run worker`): a long-running Node process. Consumes the send
  queue, sends the DMs, runs the polling reconciler, and performs the follow-gate
  `is_user_follow_business` checks. **Must stay always-on**, so it cannot run on
  Vercel — it needs an always-on host.
- **PostgreSQL**: campaigns, DM logs, accounts, sessions, tracked links, click events.
- **Redis**: the BullMQ send queue and the per-account rate limiter. Must speak the
  native Redis protocol over TCP (an HTTP-only Redis will not work with BullMQ).

The web app and the worker must share the same `DATABASE_URL`, `REDIS_URL`, and
`ENCRYPTION_KEY`. The web app stores the encrypted Instagram token; the worker
decrypts it to send. Different keys mean every send fails to decrypt.

## Reference free deployment

The zero-cost stack this instance runs on. Alternatives (e.g. Railway for the
worker + Postgres + Redis) are covered in [setup.md](setup.md).

| Piece | Service | Free tier |
| --- | --- | --- |
| Web app | Vercel (Hobby) | Free |
| PostgreSQL | Neon | Free (~0.5 GB) |
| Redis | Redis Cloud (Essentials) | Free (30 MB, TCP) |
| Worker (24/7) | Oracle Cloud "Always Free" VM (VM.Standard.E2.1.Micro, Ubuntu 22.04, kept alive with `pm2`) | Free forever |
| Login email | Resend | Free (3k emails/mo) |
| Instagram API | Meta app with Instagram Login | Free |

## Environment variables

Names only — values live in `.env` (gitignored) or the host's env settings, never
in the repo. Full descriptions are in [setup.md](setup.md#environment-variables).

`NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `CRON_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`,
`REDIS_URL`, `RESEND_API_KEY`, `EMAIL_FROM`, `META_GRAPH_API_VERSION`,
`INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`,
`WEBHOOK_VERIFY_TOKEN`.

Optional, all with working defaults — see [Sending behaviour](#sending-behaviour)
for what they do: `COMMENT_POLL_INTERVAL_MS`, `COMMENT_POLL_LOOKBACK_HOURS`,
`COMMENT_POLL_MAX_PER_SWEEP`.

## Sending behaviour

The parts that are easy to get wrong, and why they are set the way they are.

### Keyword matching is unicode-aware

Comment text is cleaned with `[^\p{L}\p{N}_\s]/gu` and whole-word matching uses
lookarounds over `\p{L}\p{N}_`, not `\b`. Both matter: JavaScript's `\w` and `\b`
are ASCII-only, so an ASCII cleaner reduces an Arabic comment to an empty string
and an ASCII word boundary never fires beside an Arabic letter. A campaign gated
on non-Latin keywords silently matches nothing.

If you change this code, keep the Arabic cases in
`__tests__/keyword-matcher.test.ts`. They are the regression guard.

### The sweep is a safety net, and it is quiet

Webhooks miss comments, so the worker also polls. Every
`COMMENT_POLL_INTERVAL_MS` (default 5 min) it re-reads each active campaign's
post and enqueues anything that matches and has not been answered.

- `COMMENT_POLL_LOOKBACK_HOURS` (default **168**) matches Instagram's own limit:
  a private reply must be sent within 7 days of the comment. Shorter abandons
  people you could still legally answer; longer just queues sends that will fail.
- `COMMENT_POLL_MAX_PER_SWEEP` (default 30) stops a viral post flooding the
  comment API in one pass.
- Dedup is **per person per campaign**, not per comment. Somebody who writes the
  keyword three times gets one DM. Commenting on two different posts still gets
  two, one from each campaign.
- The sweep only writes an operational event when it enqueues something or hits
  an error. **A campaign matching nothing logs nothing**, so silence in
  `/diagnostics` is not evidence the sweep ran and found nothing to do.

### Sends are paced

The worker runs `concurrency: 2` behind a 10-per-minute limiter (600/hour). The hourly cap in
`lib/utils/rate-limiter.ts` (750/hour, Meta's documented figure for private
replies) says nothing about burst rate — firing ~80 sends in 90 seconds gets the
tail throttled well under that cap. A backlog should drain over minutes.

### Exactly one worker, and you can tell which code it runs

The worker takes a **Redis singleton lock** (`openreply:worker:singleton`) at boot
and refuses to start if another holds it, naming the holder. It refreshes on each
heartbeat, releases on clean shutdown, and expires after 90s if the process is
SIGKILLed. The lock is in Redis rather than a pidfile so it holds across machines.

This exists because two workers ran for hours on 2026-08-26 without anyone
noticing. `pkill` on the npm parent leaves the tsx child reparented to init and
still sweeping, so every careless restart adds an instance. Two workers means two
sweeps every 5 minutes, double the send rate, and a queue full of duplicates.

Boot logs the running code:

```
[DM Worker] code 4ad5245+local-edits · owner Mohammads-MacBook-Air.local:78763
```

`+local-edits` means the tree has uncommitted changes; a bare sha means what runs
is what is committed. Check this before concluding a fix is or is not live.

### The queue can eat itself

The sweep re-enqueues anything not yet marked handled, every 5 minutes. If the
send limiter drains slower than that, the same comments pile up — 537 jobs for 153
real comments, one queued 17 times, observed 2026-08-26. Two guards now:

- **Deterministic job id** (`c_<automationId>_<commentId>`) with
  `removeOnComplete`, so a comment cannot be queued twice while pending, and the
  id frees the instant it finishes so real retries still work.
- **A skip is recorded.** When the per-person guard drops a comment because that
  person was already messaged, it writes a `SKIPPED_DEDUP` DmLog row, and that
  status counts as handled. Without it those comments returned every sweep
  forever and ate the send budget while new comments waited.

If the queue is growing rather than draining, check duplication first: count
waiting `process-comment` jobs against distinct `commentId`s. Anything above ~2x
(webhook + polling for the same comment is normal) means a guard is broken.

### Restarting the worker

The worker reads its source at boot and has no watch mode, so **no code change
reaches the sender until the process is restarted** — a fix can be committed and
passing tests while the running sender still has the old behaviour.

Restart only when the queue is idle (`waiting` and `active` both 0). BullMQ treats
a job killed mid-flight as stalled and re-runs it, and re-running a private reply
that already landed delivers a duplicate to a real person. For the same reason,
avoid `tsx watch` here: it would bounce the worker mid-send on every save.

### A failed private reply is never retried

Meta sometimes returns a generic `Error 1: An unknown error has occurred` for a
private reply it actually delivered. Instagram allows exactly **one private reply
per comment**, so retrying cannot repair a failed send — it can only deliver a
second copy to someone who already got the first.

The worker therefore logs `FAILED` and stops. The consequence to understand:

> **`FAILED` does not mean undelivered.** Before resending anything by hand, check
> the real thread via the conversations API — filter `user_id` by the `commenterId`
> on the log row. Bulk-retrying failed rows is how you spam your own audience.
