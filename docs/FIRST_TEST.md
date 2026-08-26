# First real end-to-end test

A no-surprises walkthrough of the first live test: log in, build one campaign on one of your
own posts, comment the keyword from a **second** Instagram account, confirm the DM lands.

Every behavioural claim below is cited as `file:line` against the code in this repo. Where the
code disagrees with `docs/setup.md`, the code wins and the disagreement is called out in
[Where the code contradicts docs/setup.md](#where-the-code-contradicts-docssetupmd).

---

## Two things that will waste your first attempt if you skip them

**1. The test comment MUST come from a different Instagram account than the connected one.**
`parseCommentEvents` drops any comment whose author id equals the account id in the webhook
entry (`lib/meta/webhook.ts:127`), before anything is queued. Commenting your keyword from the
connected account produces a `WebhookEvent` row and then *absolute silence* — no queue job, no
`DmLog` row, no error anywhere. This is deliberate: Instagram rejects a private reply to
yourself. Confirmed by test `should ignore comments from the connected account itself`
(`__tests__/webhook.test.ts:216`). Use a friend's account or a second account of your own.

**2. The Meta app must be Published (Live) for real comment webhooks to arrive.**
In Development mode only the console's "Send to My Server" test button delivers events
(`docs/setup.md:186`). *However* — and setup.md does not say this — the worker also runs a
polling reconciler every 5 minutes that reads comments straight off the Graph API and can
deliver the DM with no webhook at all (`worker/dm-worker.ts:43-44`,
`lib/polling/comment-reconciler.ts:64-104`). So a DM that arrives ~5 minutes late with **no**
matching `WebhookEvent` row means your webhook is broken and polling rescued you. Fix the
webhook anyway; polling is capped and lossy (`lib/polling/comment-reconciler.ts:41-46`).

---

## Before you start

| Check | How | Why |
| --- | --- | --- |
| Worker is alive | `GET /api/health` → `checks.worker.healthy === true` | Nothing sends without it (`app/api/health/route.ts:72-89`). A dead worker leaves jobs in Redis forever with zero DB evidence. |
| Web and worker share one Redis | Compare `REDIS_URL` on both | The web app enqueues (`app/api/webhook/route.ts:93`), the worker consumes. Two Redises = jobs go nowhere, silently. |
| Web and worker share one `ENCRYPTION_KEY` | Compare env values | Mismatch → `DmLog.status = FAILED`, `errorMessage = "Failed to decrypt Instagram access token"` (`lib/queue/dm-worker.ts:291-318`). |
| The connected IG account is Business/Creator, is an app tester, and *accepted* the tester invite | Instagram app → Settings → Apps and websites → Tester invites | `docs/setup.md:142-157`. |
| Meta webhook subscribes the `comments` field | Meta app → Instagram → Configure webhooks | Any other field is discarded at `lib/meta/webhook.ts:113`. |
| Callback URL is the **primary** domain, no trailing slash | `https://openreply-chi-lac.vercel.app/api/webhook` | A non-primary domain 307-redirects the POST and Meta does not follow it (`docs/setup.md:182`). |

---

## 1. The walkthrough

### Step 1 — Sign in

1. Open `https://openreply-chi-lac.vercel.app/login`.
2. Field **Work email** → your email. Button **Email me a magic link**.
   Login is Resend magic-link only; there is no password provider (`lib/auth.ts:11-16`).
3. Open the link on the same device. A workspace is created automatically on first sign-in
   (`lib/auth.ts:26-30`, `lib/auth.ts:48-61`), and you are its OWNER — required, because only
   OWNER/ADMIN may create campaigns (`app/api/automations/route.ts:287-292`).

**Check:** you land on `/dashboard`. The left nav shows Dashboard, Overview, Inbox, Campaigns,
DM Logs, Settings, Diagnostics (`components/sidebar.tsx:13-19`).

### Step 2 — Connect Instagram

1. **Settings** → section **Instagram Connection** → button **Connect Instagram**
   (`app/(dashboard)/settings/page.tsx:213-216`).
2. You should reach Instagram's consent screen requesting
   `instagram_business_basic, instagram_business_manage_messages,
   instagram_business_manage_comments, instagram_business_manage_insights`
   (`lib/meta/oauth.ts:76-77`). Approve.

If the button bounces you back to `/settings?instagram=misconfigured&missing=…`, env vars are
missing — the list is in the query string (`app/api/instagram/connect/route.ts:18-25`).

**Check after this stage:**
- Redirect lands on `/dashboard?connected=true` (`app/api/instagram/callback/route.ts:107`).
- In Postgres: `SELECT "instagramId", username, "webhookSubscribed" FROM "InstagramAccount";`
  `instagramId` is the *professional account id* (`user_id`), not the app-scoped id
  (`app/api/instagram/callback/route.ts:57`). This value must equal `entry.id` in the incoming
  webhook or nothing will ever match.
- `webhookSubscribed = false` is **not fatal** — the subscribe call is best-effort and a failure
  is only `console.warn`'d (`app/api/instagram/callback/route.ts:72-84`) — but it's a strong hint
  your webhook will not fire. Re-check the Meta webhook config if it's false.
- A failed connect writes `OperationalEvent(source=SYSTEM, level=ERROR, message="Instagram
  connection failed")` with the reason in `payload` (`app/api/instagram/callback/route.ts:114-124`).

### Step 3 — Build the campaign

**Campaigns → New Campaign** (`/campaigns/new`, `components/campaign-builder.tsx`).
Fill exactly these, and nothing else:

| UI field / control | What to enter | Notes |
| --- | --- | --- |
| **Campaign name (optional)** | `First test` | Optional; defaults to `Campaign for @username` (`campaign-builder.tsx:401`). Max 100 chars. |
| **Instagram account** selector | only appears if you have >1 account (`campaign-builder.tsx:650`) | Otherwise the single account is used. |
| **When someone comments on** → radio **a specific post or reel** | selected (it is the default, `campaign-builder.tsx:147`) | Then pick one thumbnail in the grid below. A post with a warning-coloured border is already used by another campaign (`components/post-picker.tsx:154-180`). |
| **And this comment has** → radio **a specific word or words** | selected (default, `campaign-builder.tsx:158`) | |
| keyword text box | `TEST` | Comma-separates into multiple keywords (`campaign-builder.tsx:191-198`); each is trimmed, blanks dropped. Max 10 keywords, 50 chars each (`app/api/automations/route.ts:27`). |
| toggle **also reply when someone DMs these words** | **OFF** | Adds a whole second trigger path needing the `messages` webhook field. |
| toggle **reply to their comments under the post** | **OFF** for the first run | See recommendations below. |
| **They will get** → toggle **an opening DM** | **OFF** | Requires the `messaging_postbacks` webhook field to complete. |
| **They will get** → toggle **a follow requirement first** | **OFF** | Same reason, plus it changes what gets sent. |
| **And then, they will get** → **a DM with a link** textarea | `Here's your test DM {username}` | **Required** — save is blocked if empty (`campaign-builder.tsx:394`; schema `dmMessage: min(1).max(1000)` at `app/api/automations/route.ts:30`). |
| **+ Add A Link** | **don't open it** | Leaving it empty sends a plain-text private reply, the simplest path (`lib/queue/dm-worker.ts:625-637`). |
| toggle **a follow-up thank-you message** | **OFF** | |

Then click **Go Live** (top-right; in `new` mode it saves with `isActive: true`,
`campaign-builder.tsx:618-626`).

Client-side validation you may hit (`campaign-builder.tsx:386-397`): no account connected; no
post picked; zero keywords with "specific word" selected; empty DM message; opening DM enabled
without both message and button label. Server-side mirrors it (`app/api/automations/route.ts:65-81`).

**Silent default worth knowing:** the builder never sends `wholeWordMatch`, so the create schema
default applies — **whole-word matching is ON** (`app/api/automations/route.ts:62`,
`prisma/schema.prisma:202`). There is no UI anywhere to change it. This decides whether `TEST`
matches `TEST123` (it does not — see below).

**Check after this stage:**
```sql
SELECT id, name, "isActive", "postId", "matchAnyPost", "pendingNextReel",
       keywords, "matchAnyWord", "wholeWordMatch", "requireFollow",
       "openingDmEnabled", "publicReplyEnabled", "dmTriggerEnabled"
FROM "Automation" ORDER BY "createdAt" DESC LIMIT 1;
```
You want: `isActive = true`, `postId` = a real media id (not null), `matchAnyPost = false`,
`pendingNextReel = false`, `keywords = {TEST}`, `wholeWordMatch = true`, and every other flag
`false`. Also confirm `Automation.instagramAccountId` points at the account row from Step 2.

### Step 4 — Post the comment from the SECOND account

On the *same post you picked*, from a **different** Instagram account, comment exactly:

```
TEST
```

Not `TEST123`, not `TESTING`, not a reply to another comment thread if you can avoid it. Then
wait ~10 seconds for the webhook path (or up to ~5 minutes for the polling fallback).

### Step 5 — Confirm the DM

The DM arrives in the second account's Instagram inbox as a **message request** from the
connected account (a private reply to the comment,
`lib/meta/client.ts:140-162` → `recipient: { comment_id }`). Check the Requests tab, not just
the main inbox.

In the dashboard: **DM Logs** (`/logs`) should show one row, status `SENT`.

```sql
SELECT status, "matchedKeyword", "commenterName", "commentText",
       "dmSentAt", "errorMessage", "publicReplySentAt", "publicReplyError"
FROM "DmLog" ORDER BY "createdAt" DESC LIMIT 5;
```

---

## 2. Things that will make your test silently fail

Ordered by where the comment dies, earliest first. "Silent" = no `DmLog` row is created at all,
so the DM Logs page stays empty and you have nothing to click on.

### A. It never reaches your server

1. **App is in Development mode.** Real comment webhooks are not delivered; only the Meta
   console's Test → "Send to My Server" button posts anything (`docs/setup.md:184-196`). No
   `WebhookEvent` row. (The 5-minute polling reconciler may still deliver the DM — see the top of
   this doc.)
2. **Webhook callback URL points at a non-primary domain.** The POST gets a 307 and Meta does not
   reliably follow it (`docs/setup.md:182`). No `WebhookEvent` row.
3. **The `comments` field is not subscribed** in the Meta webhook config. Nothing is sent.
4. **The tester invite was never accepted inside Instagram.** Half the people who "did step 6"
   only did the Meta half (`docs/setup.md:150-157`). The account is not really connected.

### B. It reaches your server and is rejected before it is recorded

5. **Signature mismatch.** `verifyWebhookSignature` HMAC-SHA256s the raw body against
   `FACEBOOK_APP_SECRET` *and* `INSTAGRAM_APP_SECRET` and accepts either
   (`lib/meta/webhook.ts:13-32`). If neither matches → HTTP 401 and **no `WebhookEvent` row at
   all**; the only trace is
   `OperationalEvent(source=SYSTEM, level=WARNING, message="Webhook signature verification
   failed")` with a body preview (`app/api/webhook/route.ts:36-58`). This is the one failure
   mode where an empty `WebhookEvent` table is expected — always check `OperationalEvent`
   before concluding "Meta isn't sending anything".
   Note: if *both* secrets are unset the function throws rather than returning false
   (`lib/meta/webhook.ts:18-22`), producing a 500.
6. **Malformed JSON** → 400, no `WebhookEvent` row (`app/api/webhook/route.ts:60-68`).

### C. It is recorded but produces no queue job

The `WebhookEvent` row is created *before* parsing (`app/api/webhook/route.ts:70-79`) and ends as
`PROCESSED` even when every event inside it was discarded (`app/api/webhook/route.ts:230-236`).
`status = PROCESSED` therefore proves **delivery**, never **action**.

7. **`payload.object !== "instagram"`.** A Facebook-Login/Page-style payload (`object: "page"`)
   is dropped wholesale (`lib/meta/webhook.ts:107`, test at `__tests__/webhook.test.ts:102`).
   This is what you get if you picked the wrong Meta use case.
8. **`change.field !== "comments"`.** `mentions`, `live_comments`, `story_insights` etc. are all
   discarded (`lib/meta/webhook.ts:113`, test at `__tests__/webhook.test.ts:128`).
9. **Missing `entry.id`, comment id, media id, or author id.** Any one absent → the event is
   skipped (`lib/meta/webhook.ts:120`). Comment id is read from `value.id` *or* `value.comment_id`;
   media id from `value.media.id` *or* `value.media_id` (`lib/meta/webhook.ts:116-117`).
10. **The comment came from the connected account itself** (`commenterId === entry.id`,
    `lib/meta/webhook.ts:127`). *The headline failure mode.* Includes comments you type on your
    own post and replies you post under someone else's comment.
11. **No `InstagramAccount` row matches `entry.id`.** The job is still enqueued
    (`app/api/webhook/route.ts:93-107`) but `WebhookEvent.workspaceId` stays `NULL`
    (`app/api/webhook/route.ts:109-114`) and the worker will find zero campaigns.
    Diagnostic: `WebhookEvent` rows with `workspaceId IS NULL` = the stored account id doesn't
    match what Meta is sending. Cure: disconnect and reconnect the account once so `user_id` is
    stored (`app/api/instagram/callback/route.ts:53-57`, `docs/setup.md:198-202`).
12. **Duplicate delivery of the same comment.** The job id is deterministic —
    `comment_<accountId>_<commentId>` (`app/api/webhook/route.ts:105`) — and completed jobs are
    retained (`removeOnComplete: {count: 1000}`, `lib/queue/client.ts:83`). BullMQ silently drops
    the second add. Harmless on a first test; relevant if you delete and re-post a comment (that
    gets a new id, so it *will* re-fire).

### D. The job exists but the worker never runs it

13. **Worker process is down** or can't reach Redis. `/api/health` returns 503 with
    `worker.healthy: false` (`app/api/health/route.ts:59-89`). Jobs pile up in `waiting`.
14. **Web app and worker point at different Redis instances.** Health looks fine on both; the
    queue is simply not shared. Check `queue.counts.waiting` on `/api/health` — a growing
    `waiting` with no `DmLog` rows is the signature.

### E. The worker runs it and finds nothing to do — still no `DmLog` row

The campaign lookup is
`{ OR: [{postId: mediaId}, {matchAnyPost: true}], isActive: true, instagramAccount.instagramId: <entry.id> }`
(`lib/queue/dm-worker.ts:202-224`).

15. **Campaign is paused** (`isActive = false`). The Campaigns-list toggle and the builder's
    **Stop** button both write this (`app/(dashboard)/campaigns/page.tsx:200-213`,
    `components/campaign-builder.tsx:598-617`).
16. **Campaign is bound to a different post** than the one you commented on. `postId` must equal
    the webhook's media id exactly.
17. **Campaign uses "next post or reel".** `pendingNextReel` campaigns have `postId = null`
    (`app/api/automations/route.ts:374-392`) and therefore match nothing until the
    `attach-next-reel` cron binds them — which on Vercel runs **once a day at 06:00 UTC**
    (`vercel.json`, `app/api/cron/attach-next-reel/route.ts:6-14`). Never use this for a test.
18. **Campaign belongs to a different Instagram account row** than the one that received the
    comment.
19. **Keyword did not match** (`lib/queue/dm-worker.ts:228-238`). The worker `continue`s before
    creating any log row. Exact semantics — see the next section.

### F. A `DmLog` row exists but the DM was not sent

These are the *visible* failures; DM Logs shows them.

20. `status = FAILED`, `"No Instagram access token available"` — the account row has no token
    (`lib/queue/dm-worker.ts:261-287`).
21. `status = FAILED`, `"Failed to decrypt Instagram access token"` — `ENCRYPTION_KEY` differs
    between web and worker, or was rotated (`lib/queue/dm-worker.ts:291-318`).
22. `status = SKIPPED_DEDUP` — another campaign already used this comment's one allowed private
    reply. Instagram permits exactly **one private reply per comment, ever**, across all
    campaigns; overlapping campaigns (a post-specific one plus an any-post one) mean only the
    first delivers (`lib/queue/dm-worker.ts:400-427`, test at `__tests__/dm-worker.test.ts:822`).
    The error message names the winning campaign.
23. Comment already handled: `status = SENT` and (public reply sent or public reply disabled) →
    skipped entirely (`lib/queue/dm-worker.ts:249-259`). Dedup key is
    `(automationId, commentId)` (`prisma/schema.prisma:249`). Re-running the same comment will
    never send a second DM.
24. `status = SKIPPED_PLAN_LIMIT` — a previous run set it and it is never retried
    (`lib/queue/dm-worker.ts:256`). The self-hosted cap is 2,000,000,000 DMs/month
    (`lib/billing/usage.ts:9`), so you should never see this unless the workspace row is missing.
25. `status = SKIPPED_RATE_LIMIT` — 750 private replies/hour/account, enforced in Redis
    (`lib/utils/rate-limiter.ts:19-22`). The job is requeued at +30 min up to 3 times, then
    skipped (`lib/queue/dm-worker.ts:471-522`).
26. `status = FAILED`, `"…invalid for a private reply"` — the comment's single private reply was
    already consumed, or the comment is too old / not eligible. The worker deliberately does not
    retry as plain text, because that retry fails identically and would overwrite the real error
    (`lib/queue/dm-worker.ts:54-71`, `lib/queue/dm-worker.ts:595-624`, test at
    `__tests__/dm-worker.test.ts:845`).
27. `status = FAILED`, `"…outside of allowed window"` — the 24-hour messaging window is closed.
    Only affects direct-message sends (button taps, follow-ups, DM triggers); a private reply to
    a fresh comment does not need an open window.
28. `status = FAILED`, `"…requested user cannot be found"` — the commenter's IGSID is not
    reachable (deleted/restricted account).
29. Job retries: 3 attempts with 5 / 15 / 45-minute backoff (`lib/queue/client.ts:91`,
    `lib/queue/dm-worker.ts:42`). A FAILED row may flip to SENT up to ~65 minutes later. Every
    exhausted failure also writes `OperationalEvent(source=WORKER, level=ERROR)`
    (`lib/queue/dm-worker.ts:1194-1237`).

### G. Failure modes you only hit if you enable the optional features

30. **Follow gate on (`requireFollow`), opening DM off.** The worker calls
    `getUserFollowStatus` (`is_user_follow_business`) at comment time. Anything other than a
    literal `true` — including `null`, i.e. Meta didn't return the field — sends the *follow
    prompt* instead of your DM (`lib/queue/dm-worker.ts:538-541`, `lib/meta/client.ts:257-277`).
    The `DmLog` row still says `SENT`. Your test then "passes" while the actual link never
    went out. This is fail-closed by design (`lib/queue/dm-worker.ts:1052-1058`).
31. **The follow prompt's button is a postback.** Completing that flow needs the
    `messaging_postbacks` webhook field subscribed (`app/api/webhook/route.ts:118-139`). If it
    isn't, tapping "i'm following" does nothing, forever, with no log line.
32. **Opening DM on.** The first message is a button template; the reveal only arrives on a
    button tap (`lib/queue/dm-worker.ts:527-559` → `processPostback`,
    `lib/queue/dm-worker.ts:681-880`). Same `messaging_postbacks` dependency. The 5-minute
    read-receipt fallback needs the `message_reads` field too
    (`app/api/webhook/route.ts:182-228`), and it usually cannot deliver anyway because the
    24-hour window is closed — that specific failure is logged to console and deliberately not
    written to `DmLog` (`lib/queue/dm-worker.ts:843-859`, test at `__tests__/dm-worker.test.ts:766`).
33. **"also reply when someone DMs these words" (`dmTriggerEnabled`).** Needs the `messages`
    webhook field. Echoes, deletions, unsupported messages and attachment-only messages are all
    dropped before the worker sees them (`lib/meta/webhook.ts:199-210`).
34. **Public reply on.** It posts *before* the DM and its failure never blocks the DM; failures
    land in `DmLog.publicReplyError`, not `errorMessage`, and the row can still be `SENT`
    (`lib/queue/dm-worker.ts:355-394`). A campaign with `publicReplyEnabled = true` but an empty
    message list silently posts nothing (`lib/queue/dm-worker.ts:355-361`).
35. **Tracked links on.** The DM becomes a button template; if Meta rejects the template the
    worker retries inline, but only for genuine template rejections
    (`lib/queue/dm-worker.ts:575-624`). Button titles are truncated to 20 chars and body text to
    640 chars by Meta (`lib/meta/client.ts:288-292`, `lib/meta/client.ts:321`). Also, tracked URLs
    are built from `NEXTAUTH_URL` on the **worker** (`lib/tracking/message.ts:54-62`) — if the
    worker's `NEXTAUTH_URL` is stale, your DM contains a dead link while everything reports `SENT`.

### Exact keyword-matching semantics

`lib/utils/keyword-matcher.ts:41-80`, verified against `__tests__/keyword-matcher.test.ts`.

Both the comment text and each keyword are run through `stripSpecialCharacters`
(`lib/utils/keyword-matcher.ts:20-30`): emoji are deleted, then **every character that is not
`[A-Za-z0-9_]` or whitespace becomes a space**, runs of whitespace collapse to one, and the
result is trimmed. Both sides are then lowercased.

| Comment | Keyword `TEST`, whole-word (the default) | Partial mode |
| --- | --- | --- |
| `TEST` | match | match |
| `test` | match (case-insensitive) | match |
| `TEST!` / `Test?` / `"TEST"` / `#TEST` | match (punctuation stripped) | match |
| `  TEST  ` | match (trimmed) | match |
| `🔥TEST🔥` / `👉TEST👈` | match (emoji stripped) | match |
| `@yourbrand TEST` | match | match |
| `I want TEST please` | match | match |
| `TEST123` | **no match** (`3` is a word char, so `\bTEST\b` fails) | match |
| `TESTING` / `pretest` | **no match** | match |
| `send_me_test` | **no match** (`_` is a word char) | match |

Other rules:
- **Multiple keywords are OR'd**, first hit wins and is recorded in `DmLog.matchedKeyword`
  (`lib/utils/keyword-matcher.ts:56-77`).
- **Multi-word keywords work**: `more info` matches `I want more info please`
  (`__tests__/keyword-matcher.test.ts:130`).
- **Hyphens split**: keyword `e-book` becomes `e book` and matches `e-book please`.
- **Non-ASCII keywords can never match.** `\w` here is ASCII-only, so Arabic, Cyrillic, and
  accented letters are all replaced by spaces. An Arabic keyword cleans down to the empty string
  and is skipped (`lib/utils/keyword-matcher.ts:57-59`); an Arabic comment cleans to empty and
  returns `matched: false` immediately (`lib/utils/keyword-matcher.ts:52-54`). **Use an ASCII
  keyword.** `café` "works" only because both sides degrade to `caf`.
- **A comment of only emoji never matches** (`__tests__/keyword-matcher.test.ts:115`).
- `matchAnyWord = true` bypasses the matcher entirely and fires on every comment
  (`lib/queue/dm-worker.ts:228-234`).
- Whole-word vs partial is `Automation.wholeWordMatch`, default `true`, **with no UI to change
  it** (`app/api/automations/route.ts:62`, `prisma/schema.prisma:202`).

---

## 3. Recommended settings for the first test

Minimise variables. Every toggle below that is OFF removes an entire class of failure.

| Setting | Value | Why |
| --- | --- | --- |
| Trigger scope | **a specific post or reel** | "any post" makes two campaigns collide on one comment's single private reply (`lib/queue/dm-worker.ts:400-427`); "next post or reel" waits for a daily cron (`vercel.json`). |
| Match mode | **a specific word or words**, keyword `TEST` | ASCII, no digits, no punctuation, no emoji — matches cleanly under whole-word mode. Avoid `link`, `info`, `price`: they show up in real comments and will fire on strangers. |
| DM message | short plain text, e.g. `Here's your test DM {username}` | `{username}` renders the commenter's handle, `there` when unknown (`lib/tracking/message.ts:75`). |
| **Add A Link** (tracked links) | **OFF** | Removes the button template, its 20-char title truncation, the template-rejection fallback path, and any dependence on the worker's `NEXTAUTH_URL`. You get a plain `sendPrivateReply` — the shortest possible path (`lib/queue/dm-worker.ts:625-637`). |
| **an opening DM** | **OFF** | With it on, the first message is a button and your DM text only arrives after a tap, which requires the `messaging_postbacks` webhook field that `docs/setup.md` never tells you to subscribe. |
| **a follow requirement first** | **OFF** | With it on, a non-follower — *or anyone whose follow status Meta won't confirm* — gets the follow prompt instead of your message, while `DmLog` still reads `SENT` (`lib/queue/dm-worker.ts:538-541`). You would misread that as a pass. |
| **reply to their comments under the post** (public reply) | **OFF** for run 1 | It's a second Graph call with its own failure mode (`publicReplyError`) that doesn't block the DM. Turn it on for run 2 once the DM path is proven — it's also the most visible confirmation for real users. |
| **also reply when someone DMs these words** | **OFF** | Requires the `messages` webhook field; unrelated to the comment path you're testing. |
| **a follow-up thank-you message** | **OFF** | Only fires after a button tap or a DM trigger (`lib/queue/dm-worker.ts:809-825`, `1115-1129`) — dead code in this configuration. |
| Status | **Go Live** (active) | An inactive campaign is invisible to the worker (`lib/queue/dm-worker.ts:207`). |

Net effect: exactly one code path runs —
`webhook → parseCommentEvents → queue → processComment → sendPrivateReply` — and every branch
that could quietly substitute a different message is disabled.

Once it works, re-enable features **one at a time**, testing each: public reply → tracked link →
follow gate (subscribing `messaging_postbacks` first).

---

## 4. What to check after each stage

`WebhookEvent` = did Meta reach us. `DmLog` = did we act. `OperationalEvent` = did something
break outside the happy path. Note there is **no `ProcessedComment` usage** anywhere in the code
despite the schema comment claiming otherwise — that table stays empty; do not diagnose with it
(`prisma/schema.prisma:256-270`, only referenced in a comment at `lib/queue/client.ts:33`).

### After connecting Instagram

```sql
SELECT "instagramId", username, "webhookSubscribed", "tokenExpiresAt"
FROM "InstagramAccount";

SELECT source, level, message, payload, "createdAt"
FROM "OperationalEvent" ORDER BY "createdAt" DESC LIMIT 10;
```
Expect one account row. `instagramId` must be the value Meta will put in `entry.id`.

### After saving the campaign

```sql
SELECT id, name, "isActive", "postId", keywords, "wholeWordMatch",
       "matchAnyPost", "pendingNextReel", "requireFollow", "openingDmEnabled",
       "publicReplyEnabled", "instagramAccountId"
FROM "Automation" ORDER BY "createdAt" DESC LIMIT 1;
```

### Immediately after posting the comment (webhook delivery)

```sql
SELECT id, object, status, "workspaceId", "errorMessage", "createdAt", "processedAt"
FROM "WebhookEvent" ORDER BY "createdAt" DESC LIMIT 5;
```
- **No row at all** → it never arrived, or the signature failed. Check `OperationalEvent` for
  `"Webhook signature verification failed"` (`app/api/webhook/route.ts:40-53`) before blaming Meta.
- **Row with `object = 'instagram'`, `status = PROCESSED`, `workspaceId` NOT NULL** → delivered
  and the account matched. Good.
- **Row with `workspaceId IS NULL`** → no `InstagramAccount` matches `entry.id` (item 11 above).
- **`status = FAILED`** → the route threw; `errorMessage` has it (`app/api/webhook/route.ts:239-248`).
- **`status = PROCESSED` but nothing in `DmLog`** → everything inside was discarded by the
  parser (self-comment, wrong object, wrong field) or by the worker (no matching campaign, no
  keyword hit). Inspect the stored `payload` JSON: compare `entry[0].changes[0].value.from.id`
  against `entry[0].id` (equal = self-comment) and `value.media.id` against your
  `Automation.postId`.

### 10–60 seconds later (worker action)

```sql
SELECT status, "matchedKeyword", "commenterId", "commenterName", "commentText",
       attempts, "dmSentAt", "errorMessage", "publicReplySentAt", "publicReplyError",
       "createdAt", "updatedAt"
FROM "DmLog" ORDER BY "createdAt" DESC LIMIT 10;
```
Statuses and what they mean: `PENDING` (attempt in flight or retrying), `SENT` (delivered),
`FAILED` (see `errorMessage`), `SKIPPED_DEDUP`, `SKIPPED_RATE_LIMIT`, `SKIPPED_PLAN_LIMIT`
(`prisma/schema.prisma:361-369`). `SKIPPED_NO_MATCH` exists in the enum but is never written.

**A missing row is the informative case**: the comment never matched a campaign or a keyword —
the worker returns before writing anything (`lib/queue/dm-worker.ts:236-238`).

### If nothing happened at all

```sql
SELECT source, level, message, payload, "createdAt"
FROM "OperationalEvent" ORDER BY "createdAt" DESC LIMIT 20;
```
- `source = WORKER, level = ERROR` → a job exhausted its retries; `payload.jobId` and
  `payload.commentId` identify it (`lib/queue/dm-worker.ts:1209-1222`).
- `source = SYSTEM, level = WARNING, message` starting `Comment sweep "<campaign>"` → the polling
  reconciler ran; the payload has `matched` / `alreadyReplied` / `enqueued` / `errors` counts
  (`lib/polling/comment-reconciler.ts:249-267`). `matched: 0` means the reconciler could see the
  comments and none matched your keyword — that isolates the failure to keyword matching, not
  webhooks. Note it only logs when something was enqueued or something errored
  (`lib/polling/comment-reconciler.ts:254`).
- `source = SYSTEM, level = WARNING, message = "Webhook signature verification failed"` → your
  app secrets are wrong.

Also useful: `GET /api/health` (db / redis / queue counts / worker heartbeat) and the
**Diagnostics** page, which surfaces queue counts, worker alerts, failed webhooks, failed DMs and
recent operational events in one view (`app/api/admin/diagnostics/route.ts`).

---

## Where the code contradicts `docs/setup.md`

Trust the code.

1. **`docs/setup.md:178` says only "Subscribe to the `comments` field."** The webhook route also
   consumes `messaging_postbacks` (`app/api/webhook/route.ts:118-139`), `messages`
   (`:142-177`) and message-read receipts (`:182-228`). Those three fields are **required** for
   the opening DM, the follow gate, and the DM keyword trigger to ever complete. With only
   `comments` subscribed, a follow-gate button tap is a no-op with no log entry. The
   recommended first-test config avoids all three.
2. **`docs/setup.md:186` says real webhooks only arrive when the app is Live** — true, but it
   frames that as the only path. The worker's polling reconciler independently fetches comments
   over the Graph API every `COMMENT_POLL_INTERVAL_MS` (default 5 min) and enqueues the same
   `process-comment` job (`worker/dm-worker.ts:33-44`, `lib/polling/comment-reconciler.ts:227-243`).
   A DM can therefore arrive with the app unpublished and the webhook broken. Don't let a
   successful test convince you the webhook works — verify a `WebhookEvent` row exists.
3. **`prisma/schema.prisma:256-270` and `lib/queue/client.ts:33-35` describe `ProcessedComment`
   as the shared webhook/polling dedup set.** Nothing in the codebase reads or writes it. Actual
   dedup is `DmLog`'s `(automationId, commentId)` unique constraint plus BullMQ job ids.
   The table will be empty; it is not a diagnostic.
4. **`components/keyword-input.tsx` is dead code.** It is imported nowhere. It upper-cases
   keywords on entry (`components/keyword-input.tsx:21`); the live builder does not
   (`components/campaign-builder.tsx:191-198`). Case is irrelevant to matching either way.
5. **`docs/setup.md:110` warns `COMMENT_POLL_MAX_PER_SWEEP` gets "closer to Instagram's rate
   limits".** The relevant in-app ceiling is 750 private replies per hour per account
   (`lib/utils/rate-limiter.ts:19`), enforced in Redis and independent of that variable.
