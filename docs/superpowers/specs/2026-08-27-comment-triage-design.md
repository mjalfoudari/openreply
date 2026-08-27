# Comment Triage — Design Spec

## Problem

MJ is bombarded with comments (CTA keyword replies + genuine audience engagement mixed
together). Instagram's native activity feed keeps resetting scroll position, so genuine
comments worth a reply get lost among CTA-keyword noise. He wants a dedicated view inside
OpenReply that surfaces only the comments worth his personal attention, lets him reply
inline, and doesn't lose his place.

Scope: Instagram first. Data model designed so YouTube can plug in later without a schema
rework.

## Non-goals

- Not replacing OpenReply's existing comment-to-DM automation (comment-reconciler.ts) —
  this is additive, reusing its fetch pass where possible.
- Not building YouTube ingestion/reply now — only the schema accommodates it.
- Not a general-purpose social inbox — no scheduling, no bulk actions, no team assignment.

## Data model

New Prisma model, separate from `ProcessedComment` (that model is automation-trigger
dedup bookkeeping with a different lifecycle — not reused here).

```prisma
enum CommentPlatform {
  INSTAGRAM
  YOUTUBE
}

enum CommentClassification {
  KEYWORD_MATCH   // hit a campaign's trigger word(s)
  GENUINE         // LLM: worth a reply
  LOW_EFFORT      // LLM: emoji/"nice"/no real content
  SPAM            // LLM: scam/bot/unrelated
}

enum CommentStatus {
  PENDING
  HANDLED    // replied
  DISMISSED  // manually skipped
}

model TriagedComment {
  id                 String   @id @default(cuid())
  workspaceId        String
  platform           CommentPlatform @default(INSTAGRAM)
  instagramAccountId String?         // set when platform = INSTAGRAM
  mediaId            String          // post/reel id
  mediaThumbnailUrl  String?
  mediaCaption       String?
  commentId          String   @unique
  authorUsername     String?
  text               String
  createdAt          DateTime        // when posted on the platform
  classification     CommentClassification
  status             CommentStatus @default(PENDING)
  repliedText        String?
  handledAt          DateTime?
  fetchedAt          DateTime @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId, status, createdAt])
  @@index([mediaId])
}
```

## Post scope

All posts from the last 7 days (matches comment-reconciler's 168h lookback), regardless
of whether they have an active automation.

## Ingestion

Extend the existing 5-minute `comment-reconciler` sweep rather than building a new
poller:

- **Posts with an active automation**: reuse the fetch that sweep already does. For each
  comment, check it against that post's campaign trigger word(s) first — a match is
  classified `KEYWORD_MATCH` immediately, no LLM call.
- **Posts without an automation, still within the 7-day window**: add a parallel fetch
  (`getRecentMediaComments`) on the same 5-minute cadence. No keyword list exists for
  these, so every comment goes to LLM classification.
- New comments are inserted as `TriagedComment` rows (`status: PENDING`). `commentId` is
  unique, so re-sweeps are naturally idempotent.

## LLM classification

- Applies to every comment that isn't a `KEYWORD_MATCH`.
- One cheap-tier model call, batched (~20 comments per request) to control cost.
- Input: comment text + the post's caption for context.
- Output: `GENUINE` / `LOW_EFFORT` / `SPAM`.
- Result is cached permanently on the row — never re-classified.

## UI — new "Comments" page in OpenReply's dashboard

Mirrors the existing Inbox page's structure (account selector, list, detail/reply pane)
but as a **flat vertical queue**, not an activity feed — this directly fixes the
scroll-reset complaint:

- Main view: `PENDING` rows with `classification = GENUINE`, oldest first (FIFO) so a
  comment never gets buried under newer ones while it waits. Each row shows the post
  thumbnail, commenter username, comment text, and an inline reply box.
- **Reply** → posts via the existing `sendCommentReply`, sets `status: HANDLED`,
  `repliedText`, `handledAt`. The row is removed from the list *in place* — polling only
  ever prepends genuinely new rows, it never reorders or refetches the whole list, so the
  view never jumps.
- **Dismiss** button → sets `status: DISMISSED`, `handledAt`. Same in-place removal.
- Secondary tab/toggle: **"Filtered (N)"** — read-only view of `KEYWORD_MATCH` /
  `LOW_EFFORT` / `SPAM` rows, for occasional spot-checking the LLM's calls. No actions
  available there.

## YouTube (future)

Same `TriagedComment` table: `platform: YOUTUBE`, `instagramAccountId: null`. A second
poller hits YouTube Data API's `commentThreads.list`; reply uses `comments.insert`. UI
needs only a platform icon/filter added to the existing list — no structural change.

## Testing

Per-piece `vitest` unit tests, no live-API end-to-end test (would need real IG
credentials — that path gets a manual smoke-test note in the implementation plan
instead):

1. Keyword-match classification given a campaign's trigger word list.
2. LLM classification cache-hit skips re-calling the model for an already-classified
   `commentId`.
3. Reply → `HANDLED` state transition, including that dismiss follows the same
   transition shape (`status` + `handledAt` set, row leaves the pending query).
