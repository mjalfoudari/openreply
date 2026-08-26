# Deployment audit — 2026-08-12

Read-only audit of this instance against `README.md`, `docs/setup.md`, `docs/stack.md`,
`.env.example`, `vercel.json`, `package.json` and the source. Nothing was changed:
no env var, no Vercel setting, no Meta setting, no code.

Ordered by "what breaks production silently", not by effort.

Live probes used as evidence are listed at the bottom under
[Verification log](#verification-log), including the ones that came back clean.
Anything I could not prove is marked **UNVERIFIED** in the finding itself.

---

## S1 — CRITICAL — Only `comments` is subscribed; four features are dead and silent

**What's wrong.** The Meta app has one webhook field subscribed (`comments`). The code
consumes four kinds of webhook event:

| Event parsed | Webhook field required | Feature it powers |
| --- | --- | --- |
| `parseCommentEvents` | `comments` ✅ subscribed | keyword → private reply |
| `parsePostbackEvents` | `messaging_postbacks` ❌ **missing** | opening-DM button, **follow gate** |
| `parseMessageEvents` | `messages` ❌ **missing** | DM keyword trigger |
| `parseReadEvents` | `messaging_seen` ❌ **missing** | 5-minute read fallback |

Nothing errors when these are missing. The DM with the button goes out, the user taps it,
and no event ever arrives — no log row, no failure, no queue job. The follow gate in
particular becomes a dead end: the commenter is asked to follow and tap, and the link is
never delivered to anyone, ever.

**Evidence.**
- `app/api/webhook/route.ts:118-139` (postbacks), `:142-177` (messages), `:182-228` (read fallback)
- `lib/meta/webhook.ts:149-176` (`parsePostbackEvents`), `:188-222` (`parseMessageEvents`), `:229-253` (`parseReadEvents`)
- `lib/queue/dm-worker.ts:681-773` — `processPostback` is the *only* code path that delivers a follow-gated link
- `docs/setup.md:178` — "Subscribe to the `comments` field." The guide is stale; it predates the follow gate, the opening DM and the DM trigger.

**Second-order risk in the same area.** On connect, the app calls
`subscribed_apps` with `subscribed_fields: ["comments", "messages"]`
(`lib/meta/client.ts:740-759`). If `messages` is not enabled on the app, that call can be
rejected outright — and the callback swallows the error
(`app/api/instagram/callback/route.ts:79-84`), storing `webhookSubscribed = false` and
continuing. Result: an account that looks connected but is subscribed to *nothing*,
including comments.

**Fix.** Meta app → Instagram → Configure webhooks → subscribe `messages`,
`messaging_postbacks` and `messaging_seen` alongside `comments`. Then connect (or
disconnect/reconnect) the Instagram account so `subscribed_apps` runs again, and confirm:

```sql
SELECT username, "webhookSubscribed" FROM "InstagramAccount";  -- must be true
```

---

## S2 — CRITICAL — OAuth asks for a 4th permission the app does not have

**What's wrong.** The authorize URL requests **four** scopes:

```
instagram_business_basic, instagram_business_manage_messages,
instagram_business_manage_comments, instagram_business_manage_insights
```

Only the first three are "Ready for testing" on the app. `instagram_business_manage_insights`
is not in the app's permission list, and is not in this repo's own review notes either.

**Evidence.**
- `lib/meta/oauth.ts:76-78` — the scope string
- `META_APP_REVIEW.md` "Permissions to request" — lists only the three
- `docs/setup.md:308` — describes review for "the messaging and comments permissions" only

**Consequence — two possibilities, and I could not determine which. UNVERIFIED.**
Meta validates the scope list *after* the tester logs in, so an unauthenticated probe cannot
tell them apart (my probe reached Instagram's login page for both the 3-scope and 4-scope
URLs; see the verification log).
- Best case: the consent screen drops the unknown scope, connection succeeds, and per-post
  views/reach/saved/shares plus the follower back-fill stay permanently empty. The code
  already degrades for this — `app/api/instagram/overview/route.ts:145-166` catches
  `PermissionError`, `lib/reports/follower-history.ts:96-101` returns 0.
- Worst case: the consent screen errors on the unknown scope and **no account can ever
  connect**, which will read as "Connect Instagram is broken".

**Fix — pick one before the first connect attempt.**
- Add `instagram_business_manage_insights` under App Review → Permissions and Features
  (Standard access / "Ready for testing" is enough for a tester), **or**
- delete it from the scope string at `lib/meta/oauth.ts:77` and accept that the follower
  chart and the per-post insight columns stay empty.

Do this *before* connecting: a token is minted with the scopes granted at consent time, so
adding the permission afterwards requires a disconnect/reconnect anyway.

---

## S3 — CRITICAL — The worker has no supervisor and its parent is a shell session

**What's wrong.** `docs/stack.md:28-31` is explicit: the worker "**Must stay always-on**".
Right now it is PID 10408 on `Mohammads-MacBook-Air.local`, uptime ~18 minutes, and its
process ancestry is a `zsh -c` invoked from a Claude Code shell snapshot — i.e. its lifetime
is bound to an agent tool call, not to a supervisor. There is no `pm2` installed and no
launchd agent for it.

When it dies (lid closed, session ended, crash, sleep), comments keep arriving and jobs keep
being enqueued to Redis, and nothing sends. Jobs are not lost — job ids are deterministic
(`app/api/webhook/route.ts:105`) — but delivery stops dead, and Instagram's private-reply
window keeps closing on those comments.

**Evidence.**
- `ps` output: `node … --env-file=.env worker/dm-worker.ts` (PID 10408), parent chain includes `/Users/mj/.claude/shell-snapshots/snapshot-zsh-…`
- `/api/health` → `worker.hostname: "Mohammads-MacBook-Air.local"`, `startedAt 2026-08-12T18:44:22Z`
- No `~/Library/LaunchAgents/*openreply*`, `pm2` not installed
- `docs/stack.md:50` — the reference free deployment for this exact role is an Oracle Cloud always-free VM kept alive with `pm2`

**Blast radius when it stops.** `/api/health` flips to `degraded` after 120 s
(`lib/ops/worker-health.ts:5`) — but nothing watches `/api/health`, so nobody is told.

**Fix (cheapest first).**
1. A launchd LaunchAgent with `KeepAlive=true` running
   `caffeinate -is npx tsx --env-file=.env worker/dm-worker.ts` with `WorkingDirectory` set to
   the repo — survives crashes and stops the Mac idle-sleeping the process.
2. Long term: the Oracle always-free VM in `docs/stack.md:50`, or any always-on box.

---

## S4 — HIGH — `npm run worker` silently runs against localhost

**What's wrong.** The documented start command does not load `.env`:

```json
"worker": "tsx worker/dm-worker.ts"      // package.json:13 — no --env-file
```

`docs/setup.md:241` and `README.md:71` both tell you to run `npm run worker`. Today it only
works because it is being started by hand with `npx tsx --env-file=.env …`. Anyone (or any
launchd/pm2 config) that follows the docs gets:

- `REDIS_URL` undefined → `new Redis(undefined!)` falls back to **localhost:6379**
  (`lib/queue/client.ts:14`, `lib/utils/rate-limiter.ts:28`) → a worker connected to a queue
  nothing writes to, with `/api/health` still reporting `worker.healthy: true` if a stale
  heartbeat is present.
- `NEXTAUTH_URL` undefined → every tracked link in every DM becomes
  `http://localhost:3000/r/<slug>` (`lib/tracking/message.ts:54-62`). Real users get dead links.
  Nothing logs an error; the DM sends successfully.

**Fix.** One line in `package.json:13`:

```json
"worker": "tsx --env-file=.env worker/dm-worker.ts"
```

---

## S5 — HIGH — The webhook delivery test in Step 8 was never performed

**What's wrong.** `docs/setup.md:180` says that after clicking Test → *Send to My Server*,
"a row should appear in your `WebhookEvent` table". There are zero rows, and zero
`OperationalEvent` rows.

A failed-signature POST would still have written an `OperationalEvent`
(`app/api/webhook/route.ts:40-53`), so this is not a signature failure — **no webhook POST has
ever reached the app**. That means the entire inbound path is unproven, including whether
`FACEBOOK_APP_SECRET` / `INSTAGRAM_APP_SECRET` on Vercel actually match the app that signs
the payloads (`lib/meta/webhook.ts:13-32`).

**Evidence.** Direct query against Neon: `WebhookEvent = 0`, `OperationalEvent = 0`,
`DmLog = 0`, `InstagramAccount = 0`, `Workspace = 0`, `User = 0`.

The GET verification handshake *is* proven working (verify token matches — see the
verification log); that path uses no secret, so it proves nothing about S5.

**Fix.** After S1, use Meta's Test → **Send to My Server** on `comments` (two-step control;
the first button only previews). Then confirm a `WebhookEvent` row exists. Do it while the
app is still unpublished — this is the only delivery you get in Development mode.

---

## S6 — HIGH (known, restated with consequences) — App unpublished, tester not accepted

Both are already known to be outstanding. Recording them here because they gate everything
above and each has a non-obvious failure mode:

- **Unpublished** (`docs/setup.md:184-196`): real comment webhooks are only delivered in Live
  state. In Development mode only the console Test button delivers. This is the single most
  common cause of "everything is configured and nothing happens".
- **Instagram tester not assigned/accepted** (`docs/setup.md:142-157`): the invite has **two
  halves** — send it in App roles, then accept it *inside the Instagram app* under Settings →
  Apps and websites → Tester invites. Skipping half two produces "Insufficient Developer Role"
  on the login screen, which reads like a code bug.

Publishing also requires the Privacy/Terms/Data-deletion URLs, which are already set and all
three return 200 (verification log).

---

## S7 — HIGH — `ENCRYPTION_KEY` parity between Vercel and the worker is unproven. UNVERIFIED

**What's wrong.** `docs/setup.md:16` and `docs/stack.md:36-38`: the web app encrypts the
Instagram token, the Mac worker decrypts it. A mismatch means **every send fails**, and the
only symptom is `"Failed to decrypt Instagram access token"` in `DmLog`
(`lib/queue/dm-worker.ts:293-317`).

No account has ever been connected, so no encrypt/decrypt round trip has happened and this
cannot be observed yet. I verified three of the thirteen Vercel values match `.env`
(`NEXTAUTH_URL`, `CRON_SECRET`, `WEBHOOK_VERIFY_TOKEN`) and that `DATABASE_URL` / `REDIS_URL`
work and point at the same Redis the worker uses. The remaining eight — including
`ENCRYPTION_KEY`, `INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`, `RESEND_API_KEY` — are not
observable from outside.

**Fix (do it before connecting the account, it is 30 seconds):**

```bash
vercel env pull /tmp/env.vercel --environment production
diff <(sort .env | grep -v '^#' | grep -v '^$') <(sort /tmp/env.vercel)
rm /tmp/env.vercel
```

Also confirm each var is set for the **Production** environment specifically, not just Preview.

---

## S8 — MEDIUM — Nobody has ever logged in; the Resend path is untested

`User = 0` in Postgres. Login is magic-link only (`lib/auth.ts:11-15`,
`docs/setup.md:22`) — there is no password fallback and no other way in. If `RESEND_API_KEY`
or `EMAIL_FROM` is wrong on Vercel, or `shakesbeard.net` is not actually sending in Resend,
you find out at the worst moment. Note `lib/auth.ts:13-14` substitutes placeholder values
when the vars are missing, so a missing key produces a delivery failure rather than a boot error.

**Fix.** Sign in once at `https://openreply-chi-lac.vercel.app/login` and confirm a `User` row
appears. Do this before the Meta work — the whole dashboard is behind it (`proxy.ts:15-32`).

---

## S9 — MEDIUM — Redis Cloud free tier: 30 client cap, no persistence

**Evidence.** Live `INFO`: `maxclients:30`, `connected_clients:5`, `maxmemory_policy:noeviction`,
`used_memory_human:2.59M`, redis 8.6.2.

`noeviction` is correct and required by BullMQ — that part is right. The ceiling is
connections, not memory:

- each Vercel lambda instance opens its own ioredis connection (`lib/queue/client.ts:12-19`)
- the worker opens several: the queue connection, BullMQ's blocking connections, plus a
  **separate** client in `lib/utils/rate-limiter.ts:26-33`

A comment burst that fans out to ~25 concurrent lambdas hits "max number of clients reached";
the webhook handler then throws, marks `WebhookEvent` FAILED and returns 500
(`app/api/webhook/route.ts:239-254`). Meta retries a limited number of times, and the polling
reconciler is the backstop (`lib/polling/comment-reconciler.ts`), so this degrades rather than
loses data — but it degrades invisibly.

Also: the free tier has no persistence. A Redis restart loses waiting/delayed jobs, including
scheduled follow-ups (`lib/queue/dm-worker.ts:809-825`) and the read-fallback jobs.

**Fix.** Nothing now — it is fine for one account. Watch `connected_clients` if you ever add
accounts or go viral; the cheap mitigation is reusing one client for the rate limiter instead
of opening a second.

---

## S10 — MEDIUM — Cron failures are silent and are never retried

The three crons authenticate correctly and need **no extra configuration** — that is confirmed,
see S15. The residual risk is failure handling:

- Vercel documents that it **will not retry** a failed cron invocation.
- Hobby precision is ±59 min and once/day max; `vercel.json` is daily, so it is compliant.
- Nothing alerts on a 500. `/diagnostics` surfaces `TOKEN_REFRESH` errors
  (`app/api/admin/diagnostics/route.ts:64-72`) only if you open the page.

Per-cron blast radius:
- `refresh-tokens` — refreshes anything expiring within 10 days
  (`app/api/cron/refresh-tokens/route.ts:6`), so it has ~10 daily chances before a token dies.
  Survivable; not silent-death territory.
- `snapshot-followers` — a missed day is **permanently lost**; Instagram retains only ~30 days
  of insights and there is no backfill beyond that (`app/api/cron/snapshot-followers/route.ts:10-16`).
- `attach-next-reel` — a "next reel" campaign just goes live one day late.

**Fix.** Check `/diagnostics` (or the `OperationalEvent` table) weekly once accounts are
connected. A Vercel log drain or an uptime monitor on `/api/health` covers both this and S3.

---

## S11 — LOW — `META_GRAPH_API_VERSION=v25.0` vs a webhook registered at v26.0

**What's wrong.** Every outbound Graph call is built as
`https://graph.instagram.com/v25.0/…` (`lib/meta/client.ts:1-9`, default at `lib/env.ts:49-51`),
while Meta will deliver webhooks in the v26.0 payload shape.

**Assessment: not a live bug.** The webhook parsers only read fields that are stable across
v25/v26 — `entry.id`, `changes[].field`/`.value`, `messaging[].postback|message|read`
(`lib/meta/webhook.ts:104-253`). The two versions are independent knobs: the webhook version
governs the payload you receive, the env var governs the path you call.

**UNVERIFIED:** whether v25.0 is still a supported version. I could not test this — an
unauthenticated call to `graph.instagram.com/v99.0/me` returns the same error 190 as v25.0,
so the host does not reject a bad version pre-auth. If v25.0 were ever sunset, *every* call
would start failing at once with no local signal.

**Fix (cheap, removes the ambiguity).** Set `META_GRAPH_API_VERSION=v26.0` in `.env` and in
Vercel Production so both sides of the integration are on one version. Note `__tests__/env.test.ts:27-32`
asserts the *default* is `v25.0`; overriding via env does not touch that test.

---

## S12 — LOW — `.env.example` is missing the three documented tuning vars

I grepped every `process.env.` reference in the repo (excluding `app/generated/prisma`) and
diffed it against the documented set. **Result: nothing reads an undocumented variable.** The
13 in `.env.example` plus exactly three optional ones are all that exist:

| Var | Read at | In `docs/setup.md`? | In `.env.example`? |
| --- | --- | --- | --- |
| `COMMENT_POLL_INTERVAL_MS` | `worker/dm-worker.ts:12` | yes (`:109`) | **no** |
| `COMMENT_POLL_MAX_PER_SWEEP` | `lib/polling/comment-reconciler.ts:44` | yes (`:110`) | **no** |
| `COMMENT_POLL_LOOKBACK_HOURS` | `lib/polling/comment-reconciler.ts:41` | yes (`:111`) | **no** |

They are worker-only and the defaults are sane, so this is documentation drift, not a
misconfiguration. `docs/stack.md:59-62` also lists only the 13.

**Fix.** Append the three commented-out defaults to `.env.example`. Nothing to change on Vercel
(the web app never reads them).

---

## S13 — LOW — `prisma.config.ts` imports `dotenv` without declaring it

```ts
// prisma.config.ts:1-3
// … assumes you have installed the following:  npm install --save-dev prisma dotenv
import "dotenv/config";
```

`dotenv` is **not** in `package.json`. It resolves only transitively:
`prisma@7.8.0 → @prisma/config → c12 → dotenv@17.4.2` (marked `devOptional` in the lock file).

`vercel-build` runs `prisma migrate deploy` on every deploy (`package.json:8`), which loads
this config file. If that transitive edge ever changes, **every deploy fails at build time**.
It is loud rather than silent, but it is a one-word fix.

**Fix.** `npm i -D dotenv`.

Related: `package-lock.json` currently has an uncommitted one-line churn
(`@types/react-dom`: `devOptional` → `dev`). Harmless; commit or discard it so deploys build
from a clean tree.

---

## S14 — INFO — Unpooled Neon on Vercel is a deliberate, bounded choice

`.env` documents the reasoning: unpooled everywhere so `prisma migrate deploy` in
`vercel-build` never deadlocks on an advisory lock through PgBouncer. That is the right call
for this codebase — there is **no** `directUrl` escape hatch available: `prisma/schema.prisma:8-10`
declares `datasource db { provider = "postgresql" }` with no `url`, and `prisma.config.ts:12`
feeds it `DATABASE_URL` only. Splitting runtime-pooled from migration-direct would require a
code change, not just an env var.

Ceiling: each Vercel instance builds its own `PrismaPg` pool (`lib/db/client.ts:8-17`) against
Neon's ~100 direct connections. Fine for one account. Revisit only if you see
`too many connections` in function logs.

---

## S15 — INFO — Things I checked that are correct (so they don't get re-litigated)

**The three Vercel crons need no additional configuration.** This was the biggest suspected
risk and it is clean:

- All three read `CRON_SECRET` and compare against `Bearer <secret>`
  (`app/api/cron/refresh-tokens/route.ts:9-17`, `attach-next-reel/route.ts:21-29`,
  `snapshot-followers/route.ts:18-26`).
- Vercel documents that setting a `CRON_SECRET` project env var makes it **automatically send
  that value as the `Authorization` header** on every cron invocation. No header wiring, no
  allowlist, nothing else to configure.
- **Verified live**: the production deployment returns `200` for a request carrying the `.env`
  `CRON_SECRET`, and `401` for the `NEXTAUTH_SECRET` fallback — which proves `CRON_SECRET` is
  set in Vercel Production *and* matches `.env`. (The probe was a provable no-op: zero
  workspaces and zero Instagram accounts exist, so the handler changed nothing —
  `{"totalProcessed":0,"workspacesReset":0}`.)
- Hobby allows 100 cron jobs per project and once-per-day scheduling; `vercel.json`'s three
  daily entries are within limits. (If you remember a "2 crons on Hobby" limit — that is no
  longer what Vercel documents.)
- The `|| process.env.NEXTAUTH_SECRET` fallback in all three handlers is a latent footgun
  worth knowing about: if `CRON_SECRET` were ever removed from Vercel, the crons would 401
  forever in silence, because Vercel would then send no header at all. It is set today.

**The domain trap in `docs/setup.md:182` is avoided.** `openreply-chi-lac.vercel.app` is the
project's *production domain*; `openreply-mjalfoudaris-projects.vercel.app` is a deployment
URL, which is what Hobby "Standard Protection" locks behind Vercel SSO ("protects all
deployments except production domains"). Every probe against the production alias returned a
direct response with **no** 307 to another host, so Meta's POSTs will not be redirected away.
Keep the Meta callback and the OAuth redirect on `openreply-chi-lac.vercel.app`.

**Also verified good:**
- `WEBHOOK_VERIFY_TOKEN` on Vercel matches `.env` — the hub challenge is echoed verbatim.
- Deployed `NEXTAUTH_URL` is `https://openreply-chi-lac.vercel.app` — read back out of a live
  redirect, and it matches the OAuth redirect URI registered in Meta exactly, no trailing slash.
- Postgres: 16 app tables + `_prisma_migrations` = 17, **18/18 migrations applied**, none
  failed or rolled back.
- Redis: `noeviction` (BullMQ's requirement), plain TCP, and the web app and the Mac worker are
  demonstrably on the **same** instance — Vercel's `/api/health` reads the heartbeat key the
  Mac worker writes.
- `/api/health` returns `status: ok` with `worker.healthy: true`.
- Legal pages required for publishing all return 200: `/privacy`, `/terms`, `/data-deletion`.
- `/r/<slug>` is live and behaves correctly (302 to `/` for an unknown slug). Tracked links
  need **no** configuration beyond `NEXTAUTH_URL`, which is correct in both places. One
  wrinkle worth knowing: click IP hashes are salted with `NEXTAUTH_SECRET`
  (`lib/tracking/server.ts:10`), so rotating that secret later silently changes all future
  hashes.
- Follow gate needs no env or dashboard config of its own beyond S1's `messaging_postbacks`.
  Behaviour is asymmetric by design: fail-**open** after a button tap
  (`lib/queue/dm-worker.ts:740-773`), fail-**closed** on first contact from a comment
  (`:538-541`) or a DM trigger (`:1052-1063`).
- `npm test` — 132 tests across 14 files, all passing.

---

## Recommended order of operations

1. `vercel env pull` + diff (S7) — 30 seconds, protects everything downstream.
2. Log in once with a magic link (S8) — proves Resend before you need it.
3. Decide the insights scope (S2) — must be settled *before* the first connect.
4. Subscribe `messages`, `messaging_postbacks`, `messaging_seen` (S1).
5. Send to My Server → confirm a `WebhookEvent` row (S5).
6. Accept the Instagram tester invite (both halves), then connect the account and check
   `webhookSubscribed = true` (S6, S1).
7. Publish the app (S6).
8. Fix the worker's lifetime (S3) and `npm run worker` (S4) before you rely on delivery.
9. Housekeeping when convenient: S11 version alignment, S12 `.env.example`, S13 `dotenv`.

---

## Verification log

Every live check run during this audit. All read-only; the one endpoint invocation was
verified to be a no-op against an empty database first.

| Check | Result |
| --- | --- |
| `GET /` , `/privacy`, `/terms`, `/data-deletion` | 200, direct (no redirect) |
| `GET /api/health` | 200 `status: ok`, worker healthy, queue 0/0/0/0 |
| `GET /api/webhook` (no params) | 403 from the route itself |
| `GET /api/webhook?hub.mode=subscribe&hub.verify_token=<from .env>&hub.challenge=…` | 200, challenge echoed → token parity confirmed |
| `GET /api/instagram/callback` (no params) | 307 → `https://openreply-chi-lac.vercel.app/settings?instagram=invalid` → deployed `NEXTAUTH_URL` confirmed |
| `GET /api/instagram/connect` (no session) | 307 → `…/login` |
| `GET /api/cron/refresh-tokens` no auth | 401 JSON from the route (not Vercel SSO) |
| same, `Bearer <CRON_SECRET from .env>` | 200 `{"totalProcessed":0,"workspacesReset":0}` → secret set in Vercel and matching; zero rows touched |
| same, `Bearer <NEXTAUTH_SECRET from .env>` | 401 → the fallback branch is not in play |
| `GET /r/nonexistent-slug` | 302 → `/` |
| `https://openreply-mjalfoudaris-projects.vercel.app/api/health` | 302 → Vercel SSO (as expected; do not use) |
| Postgres (read-only `SELECT`s) | 17 tables, 18/18 migrations applied, all counts 0 |
| Redis `INFO` / `KEYS` | `noeviction`, `maxclients:30`, `connected_clients:5`, 2.59 MB used, worker heartbeat key present |
| `ps` / launchd / pm2 | worker parented by a Claude Code shell, ~18 min uptime, no supervisor |
| `npm test` | 132/132 passing |
| `npm ls dotenv` | resolved transitively via `prisma → @prisma/config → c12` |
| Instagram authorize URL, 4-scope vs 3-scope | both reach the IG login page; scope validation happens post-login, so S2 stays UNVERIFIED |
| `graph.instagram.com/{v23,v25,v26,v99}.0/me` | identical error 190 for all → version validity not testable without a token |
| Vercel docs (cron secret, Hobby cron limits, deployment protection) | fetched and quoted above |
