# Diagnostic runbook

Query Postgres directly. It is faster than logs and it is the only place most of
this is recorded.

```bash
cd /path/to/openreply
export DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')"
psql "$DATABASE_URL"
```

Table names are PascalCase and **must be double-quoted** (`"DmLog"`, not `dmlog`).
Column names too (`"createdAt"`).

Some queries below use psql variables (`\set name 'value'`) so you set an id once
and paste the whole block.

---

## The pipeline, in the order it can break

1. Meta POSTs `/api/webhook` → HMAC checked against `FACEBOOK_APP_SECRET` **or**
   `INSTAGRAM_APP_SECRET` (either may match).
2. Row inserted into `WebhookEvent` (status `PENDING`), payload stored verbatim.
3. Payload parsed into comment / message / postback / read events. Anything
   unparseable is **dropped with no record beyond the raw payload**.
4. A BullMQ job is added to the `dm-processing` Redis queue.
5. `WebhookEvent.status` → `PROCESSED` (or `FAILED` + `errorMessage` if anything threw).
6. Worker (`pnpm worker` → `worker/dm-worker.ts`) picks the job up, matches
   campaigns, writes `DmLog`, calls Meta.

A separate polling reconciler runs **inside the same worker process** every 5 min
(`COMMENT_POLL_INTERVAL_MS`) and re-enqueues comments the webhook missed.

---

## Symptom 1 — "I commented the keyword and no DM arrived"

Run these in order. The first one that returns nothing is where it broke.

```sql
\set needle 'yourkeyword'
```

### 1a. Did the webhook arrive at all?

```sql
SELECT w.id, w."createdAt", w.status, w."errorMessage",
       e->>'id'                        AS ig_account_id,
       c->'value'->>'id'               AS comment_id,
       c->'value'->>'text'             AS comment_text,
       c->'value'->'from'->>'username' AS commenter
FROM "WebhookEvent" w
CROSS JOIN LATERAL jsonb_array_elements(w.payload->'entry') AS e
CROSS JOIN LATERAL jsonb_array_elements(e->'changes')       AS c
WHERE c->>'field' = 'comments'
  AND c->'value'->>'text' ILIKE '%' || :'needle' || '%'
ORDER BY w."createdAt" DESC
LIMIT 20;
```

Nothing back → go to **Symptom 2**. Note the `comment_id`; the rest of the trace
uses it.

```sql
\set comment_id 'PASTE_COMMENT_ID_HERE'
```

- `status = 'FAILED'` → read `errorMessage`. The only I/O in that block is
  Postgres and `queue.add`, so this is almost always Redis unreachable
  (`REDIS_URL`).
- `status = 'PROCESSED'` means **only that the route finished without throwing**.
  It does *not* mean a comment was parsed or a job was queued.

### 1b. Was the comment silently dropped during parsing?

If 1a found the payload but the comment never reached the queue, check the four
silent drops in `parseCommentEvents` (`lib/meta/webhook.ts`):

```sql
SELECT w.id, w."createdAt", w.object,
       e->>'id'                    AS entry_id,
       c->>'field'                 AS field,
       c->'value'->>'id'           AS value_id,
       c->'value'->>'comment_id'   AS value_comment_id,
       c->'value'->'media'->>'id'  AS media_id,
       c->'value'->>'media_id'     AS media_id_flat,
       c->'value'->'from'->>'id'   AS commenter_id
FROM "WebhookEvent" w
CROSS JOIN LATERAL jsonb_array_elements(w.payload->'entry') AS e
CROSS JOIN LATERAL jsonb_array_elements(e->'changes')       AS c
WHERE w.payload::text LIKE '%' || :'comment_id' || '%';
```

The event is dropped, with no further trace anywhere, when:

| Condition | Meaning |
|---|---|
| `object` ≠ `instagram` | wrong webhook product subscribed in the Meta app |
| `field` ≠ `comments` | not a comment change (e.g. `mentions`, `live_comments`) |
| both `value_id` and `value_comment_id` null | malformed payload |
| both `media_id` and `media_id_flat` null | malformed payload |
| `commenter_id` null | malformed payload |
| `commenter_id = entry_id` | **the account commented on its own post** — self private-replies are rejected by Meta, so they are dropped on purpose. This also drops replies *you* posted. |

### 1c. Does a campaign actually cover this post + keyword?

```sql
SELECT a.id, a.name, a."isActive", a."postId", a."matchAnyPost",
       a.keywords, a."matchAnyWord", a."wholeWordMatch",
       a."publicReplyEnabled", a."openingDmEnabled", a."requireFollow",
       ig.username, ig."instagramId", ig."webhookSubscribed", ig."tokenExpiresAt"
FROM "Automation" a
JOIN "InstagramAccount" ig ON ig.id = a."instagramAccountId"
ORDER BY a."createdAt" DESC;
```

The worker selects campaigns with `isActive = true` AND
(`postId` = the webhook's media id **OR** `matchAnyPost = true`) AND the account's
`instagramId` matching. If no campaign qualifies, **no `DmLog` row is ever
written** — silence is the signal.

Matching semantics (`lib/utils/keyword-matcher.ts`):
- `matchAnyWord = true` → every comment matches, keywords ignored.
- Otherwise: text and keyword are both emoji-stripped, every non-`\w` character
  becomes a space, runs of whitespace collapse, then lowercased.
- `wholeWordMatch = true` (default) → `\bkeyword\b` on the cleaned text. A keyword
  containing punctuation (`e-book`, `link!`) becomes `e book` after cleaning and
  the `\b` regex is built from that — so multi-token keywords match only if the
  comment has the same spacing.
- `wholeWordMatch = false` → plain substring.
- First keyword in array order wins; it is stored in `DmLog.matchedKeyword`.

### 1d. Did the worker write a DmLog row?

```sql
SELECT d.id, a.name AS campaign, d.status, d."matchedKeyword", d.attempts,
       d."dmSentAt", d."errorMessage",
       d."publicReplySentAt", d."publicReplyError",
       d."createdAt", d."updatedAt"
FROM "DmLog" d
JOIN "Automation" a ON a.id = d."automationId"
WHERE d."commentId" = :'comment_id'
ORDER BY d."updatedAt" DESC;
```

- **No row** → the job never ran, or ran and matched nothing. Check the queue is
  being drained (**Symptom 4**) and re-check 1c.
- **Row exists** → read the status against the table in
  [DmStatus reference](#dmstatus-reference) below.

### 1e. Did the job fail inside the worker?

```sql
SELECT "createdAt", level, message,
       payload->>'jobId'              AS job_id,
       payload->>'attemptsMade'       AS attempts,
       payload->>'instagramAccountId' AS ig_account_id,
       payload->>'commentId'          AS comment_id
FROM "OperationalEvent"
WHERE source = 'WORKER'
  AND (payload->>'commentId' = :'comment_id' OR payload->>'jobId' LIKE '%' || :'comment_id' || '%')
ORDER BY "createdAt" DESC;
```

One row is written per failed **attempt** (3 attempts max, backoff 5 / 15 / 45 min).

---

## Symptom 2 — "Webhooks are not arriving at all"

### 2a. Is anything arriving?

```sql
SELECT date_trunc('hour', "createdAt") AS hour, object, status, count(*)
FROM "WebhookEvent"
WHERE "createdAt" > now() - interval '24 hours'
GROUP BY 1,2,3
ORDER BY 1 DESC;
```

Rows here = Meta is reaching you and the signature passed. Zero rows → 2b.

### 2b. Is the signature being rejected?

A signature-mismatched POST returns 401 and writes **no `WebhookEvent`** — only
this:

```sql
SELECT "createdAt",
       payload->>'hadSignatureHeader' AS had_sig_header,
       payload->>'bodyLength'         AS body_len,
       payload->>'bodyPreview'        AS body_preview
FROM "OperationalEvent"
WHERE message = 'Webhook signature verification failed'
ORDER BY "createdAt" DESC
LIMIT 20;
```

Rows here → `FACEBOOK_APP_SECRET` / `INSTAGRAM_APP_SECRET` is wrong. The verifier
accepts a match against *either*, so both being wrong is what it takes to fail.
`had_sig_header = false` means the `x-hub-signature-256` header was absent
entirely — that is a caller that is not Meta, or a proxy stripping headers.

### 2c. Is anything arriving except comments?

```sql
SELECT w."createdAt", w.object, w.status,
       jsonb_pretty(w.payload) AS payload
FROM "WebhookEvent" w
ORDER BY w."createdAt" DESC
LIMIT 5;
```

If you see `messaging` entries but never `changes` with `field = 'comments'`, the
app is subscribed to the messaging fields but not the `comments` field in the Meta
app's webhook config.

### 2d. Subscription state

```sql
SELECT username, "instagramId", "webhookSubscribed", "connectedAt",
       "tokenExpiresAt", "tokenExpiresAt" - now() AS expires_in
FROM "InstagramAccount"
ORDER BY "connectedAt" DESC;
```

**`webhookSubscribed` is not live state.** It records whether the subscribe call
succeeded at OAuth-callback time (`app/api/instagram/callback/route.ts`) and is
never refreshed afterwards. `true` here with zero `WebhookEvent` rows means the
subscription lapsed on Meta's side — reconnect the account to re-run the subscribe
call.

Also check the GET verification handshake separately: it compares
`hub.verify_token` to `WEBHOOK_VERIFY_TOKEN` and records **nothing** on failure.
The only evidence is Meta's own webhook config page showing the callback as
unverified.

### 2e. Related: did connecting the account fail?

```sql
SELECT "createdAt", level, message, payload->>'reason' AS reason
FROM "OperationalEvent"
WHERE message IN ('Instagram connection failed', 'Follower snapshot failed')
   OR source = 'TOKEN_REFRESH'
ORDER BY "createdAt" DESC
LIMIT 20;
```

---

## Symptom 3 — "DM shows as sent but recipient got nothing"

`status = 'SENT'` means Meta's API returned success for the send call. Meta
accepting a private reply and Instagram surfacing it to the user are different
things.

### 3a. Confirm what was actually sent, and by which path

```sql
SELECT d."commentId", d."commenterId", d."commenterName", d.status, d."dmSentAt",
       a.name AS campaign,
       a."openingDmEnabled", a."requireFollow",
       a."followUpEnabled", a."followUpDelayMinutes",
       (SELECT count(*) FROM "TrackedLink" t WHERE t."automationId" = a.id) AS tracked_links
FROM "DmLog" d
JOIN "Automation" a ON a.id = d."automationId"
WHERE d.status = 'SENT'
ORDER BY d."dmSentAt" DESC
LIMIT 20;
```

`commentId` tells you which code path wrote the row — the column is overloaded:

| `commentId` shape | Path | `commentText` |
|---|---|---|
| a real numeric comment id | comment → private reply | the comment |
| `reveal:<IGSID>` | button tap (postback) or 5-min read fallback | `(button tap)` |
| `dm:<messageId>` | inbound-DM keyword trigger | the inbound message |

**The most common cause of "SENT but nothing received":** the campaign has
`openingDmEnabled = true` or `requireFollow = true`. What was delivered is the
opening DM / follow prompt — a *button* message. The actual link only goes out
after the user taps it, which produces a **separate** `reveal:<IGSID>` row:

```sql
\set igsid 'PASTE_COMMENTER_ID'
SELECT a.name AS campaign, d."commentId", d.status, d."dmSentAt", d."errorMessage"
FROM "DmLog" d JOIN "Automation" a ON a.id = d."automationId"
WHERE d."commenterId" = :'igsid'
ORDER BY d."createdAt";
```

A comment-path `SENT` with no matching `reveal:` row = the user never tapped the
button, or the tap postback never arrived.

### 3b. Was it a private reply that Instagram filtered?

Private replies land in the recipient's **Message Requests**, not their inbox,
when they do not follow the account. There is nothing in the schema that
distinguishes this — it is the default explanation when 3a shows a plain
comment-path `SENT` with no opening DM.

### 3c. Read-fallback sends are deliberately not logged as failures

If the user read the opening DM but never tapped, a delayed job retries the reveal
after 5 minutes. When that fails (the 24-hour messaging window is closed, which is
the expected case), the worker **returns without writing anything** — no `FAILED`
row, no `OperationalEvent`. Absence of evidence here is normal, not a bug.

### 3d. Public reply vs DM are independent

```sql
SELECT d."commentId", d.status AS dm_status, d."publicReplySentAt", d."publicReplyError"
FROM "DmLog" d
WHERE d."publicReplyError" IS NOT NULL
   OR (d."publicReplySentAt" IS NULL AND d.status = 'SENT')
ORDER BY d."updatedAt" DESC
LIMIT 20;
```

The public comment reply is posted before the DM and tracked separately. A DM
failure never suppresses it, and a failed public reply never blocks the DM.

---

## Symptom 4 — "Worker looks dead"

**The heartbeat is not in Postgres.** It lives in Redis at `health:worker:dm` with
a 120-second TTL (`lib/ops/worker-health.ts`). The authoritative check is:

```bash
curl -s https://openreply-chi-lac.vercel.app/api/health | jq
```

`checks.worker.healthy = false` → the worker process is not running or cannot
reach Redis. `checks.queue.counts` shows `waiting` / `active` / `delayed` /
`failed`.

Postgres-side proxies, in order of usefulness:

### 4a. Is the reconciler still sweeping? (best liveness proxy)

The polling reconciler runs **inside the worker process**, so a recent sweep event
proves the worker is alive:

```sql
SELECT "createdAt", level, message,
       payload->>'enqueued'       AS enqueued,
       payload->>'matched'        AS matched,
       payload->>'alreadyReplied' AS already_replied,
       payload->'errors'          AS errors
FROM "OperationalEvent"
WHERE message LIKE 'Comment sweep%'
ORDER BY "createdAt" DESC
LIMIT 20;
```

**Caveat:** `recordSweep` writes nothing when a sweep enqueued 0 comments and hit
0 errors. A healthy, idle worker produces no rows here. Silence proves nothing on
its own; a row within the last ~5 minutes proves liveness.

### 4b. Worker-level errors

```sql
SELECT "createdAt", level, message, payload
FROM "OperationalEvent"
WHERE source = 'WORKER'
ORDER BY "createdAt" DESC
LIMIT 30;
```

`DM worker process error: …` is a BullMQ/Redis-connection level failure (the whole
worker is unhealthy). `DM worker job <id> failed: …` is a single job.

### 4c. Rows stuck in PENDING

```sql
SELECT d.id, a.name AS campaign, d."commentId", d.attempts,
       d."errorMessage", d."createdAt", d."updatedAt",
       now() - d."updatedAt" AS stale_for
FROM "DmLog" d
JOIN "Automation" a ON a.id = d."automationId"
WHERE d.status = 'PENDING'
  AND d."updatedAt" < now() - interval '15 minutes'
ORDER BY d."updatedAt";
```

`PENDING` older than a few minutes means the worker died between writing the row
and calling Meta — **unless** `errorMessage = 'Hourly rate limit hit; retry
scheduled'`, which is a deliberate 30-minute delayed requeue.

### 4d. Recent throughput

```sql
SELECT date_trunc('hour', "updatedAt") AS hour, status, count(*)
FROM "DmLog"
WHERE "updatedAt" > now() - interval '24 hours'
GROUP BY 1,2
ORDER BY 1 DESC;
```

If `WebhookEvent` rows keep arriving while `DmLog` stops updating, the webhook
route (Vercel) is fine and the worker (wherever you host it) is the dead half.

**Restart:** `pnpm worker` / `npm run worker` on the worker host. Retained failed
jobs are cleared after 300 s, so a comment that failed permanently *can* be
retried by a later reconciler sweep once the worker is back.

---

## Symptom 5 — "Comments are caught by polling but never by webhook"

### First, a schema trap

`ProcessedComment` (with its `source` column documented as `"WEBHOOK" | "POLLING"`)
is **dead**. No code in this repo reads or writes it — the only mention outside
the schema is a stale comment in `lib/queue/client.ts`. The `source` field on the
queue job is set by both callers and then never persisted. The table is empty and
will stay empty.

```sql
-- Confirms the trap; expect 0.
SELECT count(*) FROM "ProcessedComment";
```

So you cannot ask the DB "which path caught this comment". Use this instead.

### 5a. Comments that got a DmLog row but never appeared in any webhook payload

These were caught by polling only — i.e. the webhook path is broken and the
reconciler is masking it.

```sql
SELECT d."commentId", d."commenterName", d."createdAt", d.status, a.name AS campaign
FROM "DmLog" d
JOIN "Automation" a ON a.id = d."automationId"
WHERE d."createdAt" > now() - interval '7 days'
  AND d."commentId" NOT LIKE 'reveal:%'
  AND d."commentId" NOT LIKE 'dm:%'
  AND NOT EXISTS (
    SELECT 1 FROM "WebhookEvent" w
    WHERE w.payload::text LIKE '%' || d."commentId" || '%'
  )
ORDER BY d."createdAt" DESC;
```

This is a full scan of `WebhookEvent.payload::text`. Fine at self-host volume;
narrow the interval if it is slow.

Interpretation:
- **All recent rows appear** → both paths work.
- **Most/all recent rows missing from `WebhookEvent`** → the webhook path is
  broken; go to **Symptom 2**. The reconciler is doing all the work and hiding it.
- **Some missing** → normal. Instagram genuinely never fires webhooks for
  collapsed/filtered/low-signal comments; that is exactly why the reconciler
  exists.

### 5b. Compare arrival volumes

```sql
SELECT
  (SELECT count(*) FROM "WebhookEvent" w
   CROSS JOIN LATERAL jsonb_array_elements(w.payload->'entry') AS e
   CROSS JOIN LATERAL jsonb_array_elements(e->'changes')       AS c
   WHERE c->>'field' = 'comments'
     AND w."createdAt" > now() - interval '24 hours')          AS webhook_comment_events,
  (SELECT count(*) FROM "DmLog"
   WHERE "createdAt" > now() - interval '24 hours'
     AND "commentId" NOT LIKE 'reveal:%'
     AND "commentId" NOT LIKE 'dm:%')                          AS dm_rows_from_comments,
  (SELECT coalesce(sum((payload->>'enqueued')::int), 0)
   FROM "OperationalEvent"
   WHERE message LIKE 'Comment sweep%'
     AND "createdAt" > now() - interval '24 hours')            AS reconciler_enqueued;
```

`webhook_comment_events` near zero while `reconciler_enqueued` is healthy is the
signature of this symptom.

### 5c. Why polling can look like it is doing nothing either

The reconciler (`lib/polling/comment-reconciler.ts`) is deliberately narrow:
- lookback `COMMENT_POLL_LOOKBACK_HOURS`, default **72 h**
- cap `COMMENT_POLL_MAX_PER_SWEEP`, default **30 comments per campaign per sweep**
- `matchAnyPost` campaigns scan only the **10** most recent media
- skips any comment the account owner has already replied to on Instagram
- skips comments already "handled": `publicReplySentAt IS NOT NULL` when
  `publicReplyEnabled`, otherwise `status = 'SENT'`
- Instagram's Hidden Words / spam filter can hide comments from the Graph API
  entirely — those are invisible to both paths.

---

## DmStatus reference

Every value in the `DmStatus` enum, what writes it, and what to do.

| Status | Written when | What to do |
|---|---|---|
| `PENDING` | Default. Worker created/reset the row and is about to call Meta. Also re-set with `errorMessage = 'Hourly rate limit hit; retry scheduled'` when a send is requeued for 30 min. | Transient. Stuck >15 min with a different (or null) `errorMessage` → worker died mid-job; see Symptom 4. |
| `SENT` | Meta accepted the send; `dmSentAt` set. | Nothing. If the user reports non-delivery, see Symptom 3 — especially the opening-DM / follow-gate case. |
| `FAILED` | Meta rejected the send, **or** `accessToken` was empty (`"No Instagram access token available"`), **or** decryption failed (`"Failed to decrypt Instagram access token"`), **or** the Redis rate-limit reservation threw. | Read `errorMessage`. Meta errors are formatted `Meta API Error <code>: <message>`. Code `190` = token expired → reconnect the account. `368`/`4`/`17` = Meta throttling → wait. `100`/`10`/`200` = permission/scope. `"invalid for a private reply"` = that comment's single allowed private reply was already used. `"outside of allowed window"` = 24-hour messaging window closed. `"Failed to decrypt…"` = `ENCRYPTION_KEY` changed since the account was connected → reconnect. The worker rethrows, so BullMQ retries up to 3× with 5/15/45-min backoff. |
| `SKIPPED_DEDUP` | Another campaign already used the one private reply Instagram permits per comment. `errorMessage` names the winning campaign. | Expected when campaigns overlap (a duplicated campaign, or `matchAnyPost` overlapping a post-specific one). Fix by narrowing campaign scope. The public reply still goes out per campaign — only the DM leg is deduped. |
| `SKIPPED_RATE_LIMIT` | The per-account hourly cap (750 private replies, Redis key `rate:dm:<instagramId>`, 1-hour TTL) was still full after 3 requeues at 30 min each. | The account is sending too fast. Comment is dropped permanently for this campaign unless a later reconciler sweep re-enqueues it. Lower volume, or lower `RATE_LIMIT_MAX` in `lib/utils/rate-limiter.ts` if Meta throttles earlier than documented. |
| `SKIPPED_PLAN_LIMIT` | `reserveWorkspaceDMSend` refused. | **In this self-hosted build the monthly limit is 2,000,000,000, i.e. effectively no cap.** So this status in practice means the `Workspace` row is missing or `dmsSentThisPeriod` is corrupt — not a real quota. **This status is sticky:** `processComment` skips any comment whose row is already `SKIPPED_PLAN_LIMIT`, forever. Clear it manually after fixing the cause. |
| `SKIPPED_NO_MATCH` | **Nothing writes this.** It exists in the enum, in the admin-diagnostics filter list, and in the UI badge map — but no code path sets it. | Expect zero rows. A non-matching comment produces **no `DmLog` row at all**. Absence of a row is the "no match" signal. |

### Clearing a sticky SKIPPED_PLAN_LIMIT

```sql
-- Inspect first.
SELECT d.id, a.name, d."commentId", d."errorMessage", d."updatedAt"
FROM "DmLog" d JOIN "Automation" a ON a.id = d."automationId"
WHERE d.status = 'SKIPPED_PLAN_LIMIT';

-- Then, once the workspace row / usage counter is fixed:
-- DELETE FROM "DmLog" WHERE status = 'SKIPPED_PLAN_LIMIT';
```

Deleting rather than flipping to `PENDING` is safer: the unique key is
`(automationId, commentId)`, and a fresh row is created cleanly on the next sweep.

---

## Skip reasons that write NO row anywhere

These are the silent drops. Nothing in `DmLog` or `OperationalEvent` records them —
only the raw `WebhookEvent.payload` is evidence they happened.

**In `parseCommentEvents`** — see Symptom 1b table.

**In `parseMessageEvents`** (inbound-DM triggers): `is_echo` (our own autoreplies,
dropped so a reply containing its own keyword cannot re-trigger itself),
`is_deleted`, `is_unsupported`, empty/whitespace-only text (attachment-only DMs),
`senderId === accountId`.

**In `parsePostbackEvents` / `parseReadEvents`**: missing payload/userId/accountId,
or `userId === accountId`.

**In `processComment`**: no active campaign matches the media id; keyword does not
match; `existingLog.status = 'SKIPPED_PLAN_LIMIT'`; DM already `SENT` and either
the public reply already posted or the campaign has no public reply.

**In `processPostback`**: payload not prefixed `reveal:` or `followcheck:`;
automation missing/inactive; account mismatch; no access token; decryption failure;
follow gate says `false` on a read-fallback; read-fallback when a reveal already
`SENT`.

**In `processFollowUp`**: any failure at all — it logs to console only.

**BullMQ deterministic job ids**: comment jobs from the webhook use
`comment_<instagramAccountId>_<commentId>`. If a job with that id is still retained
(last 1000 completed; failed kept 300 s), `queue.add` is a silent no-op. This is
why the reconciler deliberately omits a jobId when re-enqueuing.

---

## OperationalEvent message catalog

Every writer in the codebase. Filter by exact `message` prefix.

| `source` / `level` | `message` | Written by | `payload` keys |
|---|---|---|---|
| `SYSTEM` / `WARNING` | `Webhook signature verification failed` | `app/api/webhook/route.ts` | `hadSignatureHeader`, `bodyLength`, `bodyPreview` |
| `SYSTEM` / `INFO` or `WARNING` | `Comment sweep "<campaign>" [<keywords>]: N enqueued, M matched, K already replied` | `lib/polling/comment-reconciler.ts` (only when `enqueued > 0` or errors) | `campaign`, `keywords`, `matched`, `alreadyReplied`, `enqueued`, `errors[]` |
| `WORKER` / `ERROR` | `DM worker job <id> failed: <msg>` | `lib/queue/dm-worker.ts`, once per failed attempt | `jobId`, `attemptsMade`, `instagramAccountId`, `commentId` |
| `WORKER` / `ERROR` | `DM worker process error: <msg>` | BullMQ worker `error` event (usually Redis) | `name` |
| `TOKEN_REFRESH` / `ERROR` | `Token refresh failed for @<username>: <msg>` | `app/api/cron/refresh-tokens/route.ts` | `instagramAccountId`, `username` |
| `SYSTEM` / `ERROR` | `Instagram connection failed` | `app/api/instagram/callback/route.ts` | `reason` |
| `SYSTEM` / `WARNING` | `Follower snapshot failed` | `app/api/cron/snapshot-followers/route.ts` | `username`, `reason` |

Firehose:

```sql
SELECT "createdAt", source, level, message, payload
FROM "OperationalEvent"
ORDER BY "createdAt" DESC
LIMIT 50;
```

Notes on the enums:
- `OperationalEventSource.HEALTH` is declared but **never written**. Expect zero rows.
- `OperationalEvent.resolvedAt` is **never set** by any code path. Always `NULL`.
- `workspaceId` is nullable and is `NULL` for signature failures and worker-process
  errors. **Do not filter operational events by `workspaceId`** when hunting a
  failure — you will hide exactly the ones you need.

---

## WebhookEvent.workspaceId is unreliable — do not filter on it

`workspaceId` is backfilled *after* the fact, and only for **comment** and
**message** events whose `entry.id` matches a row in `InstagramAccount`. It stays
`NULL` for:
- postback-only and read-receipt-only payloads (button taps, read fallbacks),
- comments from an Instagram account not connected to this instance,
- anything that failed before the backfill ran.

Always query `WebhookEvent` unfiltered, or by `createdAt` / payload content.

Corollary: a comment from an unconnected Instagram account is still **queued** —
the account lookup only supplies the `workspaceId`. The worker then finds no
campaigns and writes nothing. Fully silent.

---

## Quick triage block

```sql
SELECT 'webhooks 1h'        AS metric, count(*)::text AS value FROM "WebhookEvent"     WHERE "createdAt" > now() - interval '1 hour'
UNION ALL SELECT 'webhooks FAILED 24h', count(*)::text FROM "WebhookEvent"     WHERE status = 'FAILED' AND "createdAt" > now() - interval '24 hours'
UNION ALL SELECT 'sig failures 24h',    count(*)::text FROM "OperationalEvent" WHERE message = 'Webhook signature verification failed' AND "createdAt" > now() - interval '24 hours'
UNION ALL SELECT 'worker errors 24h',   count(*)::text FROM "OperationalEvent" WHERE source = 'WORKER' AND "createdAt" > now() - interval '24 hours'
UNION ALL SELECT 'last sweep',          coalesce(max("createdAt")::text, 'never') FROM "OperationalEvent" WHERE message LIKE 'Comment sweep%'
UNION ALL SELECT 'dm SENT 24h',         count(*)::text FROM "DmLog" WHERE status = 'SENT'   AND "updatedAt" > now() - interval '24 hours'
UNION ALL SELECT 'dm FAILED 24h',       count(*)::text FROM "DmLog" WHERE status = 'FAILED' AND "updatedAt" > now() - interval '24 hours'
UNION ALL SELECT 'dm stuck PENDING',    count(*)::text FROM "DmLog" WHERE status = 'PENDING' AND "updatedAt" < now() - interval '15 minutes'
UNION ALL SELECT 'active campaigns',    count(*)::text FROM "Automation" WHERE "isActive"
UNION ALL SELECT 'connected accounts',  count(*)::text FROM "InstagramAccount";
```

Pair it with `curl -s https://openreply-chi-lac.vercel.app/api/health | jq` for the
Redis/queue/worker half, which Postgres cannot answer.
