# Comment Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Comments" view to OpenReply's dashboard that surfaces only genuine
audience comments (filtering out CTA-keyword hits and LLM-flagged low-effort/spam) as a
stable, non-scrolling queue MJ can reply to or dismiss one at a time.

**Architecture:** A new `TriagedComment` table stores every recent comment with a cached
classification. A new sweep function (`sweepTriageComments`), run on its own interval in
the existing worker process, fetches recent comments per connected account, classifies
each against that post's automation keywords (instant) or an LLM (cached forever), and
upserts rows. A new dashboard page reads `PENDING`/`GENUINE` rows and lets MJ reply
(posts via the existing `sendCommentReply`, marks `HANDLED`) or dismiss (`DISMISSED`).

**Tech Stack:** Next.js 16 (App Router), Prisma 7 / Postgres, existing `lib/meta/client.ts`
Instagram Graph API wrapper, Anthropic SDK (new dependency) for classification, Vitest.

**Deviation from spec:** The spec's "reuse the fetch [comment-reconciler] is already
doing" is implemented as an *independent* fetch (calling the same `getRecentMediaComments`
API function, not sharing in-memory state with `sweepCampaign`). `comment-reconciler.ts`
has hard-won, heavily-commented dedup/retry semantics for DM sending (see its own
comments about incidents from 2026-08-26) — intertwining a second, differently-scoped
concern into that function risks breaking that logic. Calling the same read-only API
function twice per sweep is a small, safe duplication; sharing control flow with a
fragile pipeline is not. This does not change any spec requirement — MJ never sees the
extra API call, and comment-reconciler is untouched.

---

## Task 1: Schema — `TriagedComment` model + migration

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add the new enums and model**

Add these at the end of `prisma/schema.prisma`:

```prisma
enum CommentPlatform {
  INSTAGRAM
  YOUTUBE
}

enum CommentClassification {
  KEYWORD_MATCH
  GENUINE
  LOW_EFFORT
  SPAM
}

enum CommentStatus {
  PENDING
  HANDLED
  DISMISSED
}

model TriagedComment {
  id                 String   @id @default(cuid())
  workspaceId        String
  platform           CommentPlatform @default(INSTAGRAM)
  instagramAccountId String?
  mediaId            String
  mediaThumbnailUrl  String?
  mediaCaption       String?
  commentId          String   @unique
  authorUsername     String?
  text               String
  createdAt          DateTime
  classification      CommentClassification
  status             CommentStatus @default(PENDING)
  repliedText        String?
  handledAt          DateTime?
  fetchedAt          DateTime @default(now())

  workspace        Workspace         @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  instagramAccount InstagramAccount? @relation(fields: [instagramAccountId], references: [id], onDelete: Cascade)

  @@index([workspaceId, status, createdAt])
  @@index([mediaId])
}
```

- [ ] **Step 2: Add the back-relations**

In `model Workspace`, add to the relations block (next to `operationalEvents`):

```prisma
  triagedComments   TriagedComment[]
```

In `model InstagramAccount`, add to the relations block (next to `followerSnapshots`):

```prisma
  triagedComments TriagedComment[]
```

- [ ] **Step 3: Generate and apply the migration**

Run: `npx prisma migrate dev --name add_triaged_comment`
Expected: creates `prisma/migrations/<timestamp>_add_triaged_comment/migration.sql` and
applies it to the local dev database. Prisma will also run `prisma generate`
automatically — confirm no errors.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add TriagedComment schema for comment triage"
```

---

## Task 2: Keyword-scope matcher

**Files:**
- Create: `lib/triage/keyword-scope.ts`
- Test: `__tests__/triage-keyword-scope.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { matchesAnyAutomation } from "../lib/triage/keyword-scope";

const baseAutomation = {
  id: "auto_1",
  postId: null as string | null,
  matchAnyPost: false,
  matchAnyWord: false,
  keywords: [] as string[],
  wholeWordMatch: true,
};

describe("matchesAnyAutomation", () => {
  it("matches when the post's automation keyword is in the comment", () => {
    const automations = [
      { ...baseAutomation, postId: "media_1", keywords: ["برومبت"] },
    ];
    expect(matchesAnyAutomation(automations, "media_1", "ابي البرومبت")).toBe(true);
  });

  it("does not match when the comment is on a different post", () => {
    const automations = [
      { ...baseAutomation, postId: "media_1", keywords: ["برومبت"] },
    ];
    expect(matchesAnyAutomation(automations, "media_2", "ابي البرومبت")).toBe(false);
  });

  it("does not match when keywords don't hit", () => {
    const automations = [
      { ...baseAutomation, postId: "media_1", keywords: ["برومبت"] },
    ];
    expect(matchesAnyAutomation(automations, "media_1", "شكرا")).toBe(false);
  });

  it("matches any post when matchAnyPost is set", () => {
    const automations = [
      { ...baseAutomation, matchAnyPost: true, keywords: ["مهتم"] },
    ];
    expect(matchesAnyAutomation(automations, "any_media_id", "مهتم")).toBe(true);
  });

  it("matches any word when matchAnyWord is set, regardless of text", () => {
    const automations = [
      { ...baseAutomation, postId: "media_1", matchAnyWord: true },
    ];
    expect(matchesAnyAutomation(automations, "media_1", "anything at all")).toBe(true);
  });

  it("returns false for an empty automation list", () => {
    expect(matchesAnyAutomation([], "media_1", "برومبت")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/triage-keyword-scope.test.ts`
Expected: FAIL — `Cannot find module '../lib/triage/keyword-scope'`

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Keyword-scope matching for comment triage.
 *
 * Mirrors comment-reconciler.ts's own matching logic so a comment triage marks
 * KEYWORD_MATCH exactly when an active automation would actually fire on it —
 * the two must never disagree, or MJ would see "genuine" comments in the
 * triage queue that are actually about to get an automated DM reply.
 */

import { matchKeywords } from "@/lib/utils/keyword-matcher";

export interface AutomationScope {
  id: string;
  postId: string | null;
  matchAnyPost: boolean;
  matchAnyWord: boolean;
  keywords: string[];
  wholeWordMatch: boolean;
}

export function matchesAnyAutomation(
  automations: AutomationScope[],
  mediaId: string,
  text: string
): boolean {
  for (const automation of automations) {
    const inScope = automation.postId === mediaId || automation.matchAnyPost;
    if (!inScope) continue;
    if (automation.matchAnyWord) return true;
    if (matchKeywords(text, automation.keywords, automation.wholeWordMatch).matched) {
      return true;
    }
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/triage-keyword-scope.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/triage/keyword-scope.ts __tests__/triage-keyword-scope.test.ts
git commit -m "feat: add keyword-scope matcher for comment triage"
```

---

## Task 3: LLM classification

**Files:**
- Create: `lib/triage/classify.ts`
- Test: `__tests__/triage-classify.test.ts`
- Modify: `package.json` (add `@anthropic-ai/sdk`)
- Modify: `.env.example`

- [ ] **Step 1: Install the SDK**

Run: `npm install @anthropic-ai/sdk`
Expected: adds `@anthropic-ai/sdk` to `package.json` dependencies.

- [ ] **Step 2: Add the env var**

Add to `.env.example`, under a new `# Comment triage` section:

```
# Comment triage
ANTHROPIC_API_KEY=sk-ant-...
```

- [ ] **Step 3: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { create: mockCreate };
  },
}));

import { classifyComments } from "../lib/triage/classify";

beforeEach(() => {
  mockCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe("classifyComments", () => {
  it("returns an empty map for an empty input without calling the model", async () => {
    const result = await classifyComments([]);
    expect(result.size).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("maps each comment id to its parsed label, in order", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: '["GENUINE","LOW_EFFORT"]' }],
    });

    const result = await classifyComments([
      { commentId: "c1", text: "how do I start?", mediaCaption: "post caption" },
      { commentId: "c2", text: "🔥", mediaCaption: "post caption" },
    ]);

    expect(result.get("c1")).toBe("GENUINE");
    expect(result.get("c2")).toBe("LOW_EFFORT");
  });

  it("leaves comments unclassified if the model response isn't valid JSON", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "sorry, I can't help with that" }],
    });

    const result = await classifyComments([
      { commentId: "c1", text: "hello", mediaCaption: null },
    ]);

    expect(result.has("c1")).toBe(false);
  });

  it("batches more than 20 comments into multiple model calls", async () => {
    mockCreate.mockImplementation(async ({ messages }: { messages: { content: string }[] }) => {
      const count = (messages[0].content.match(/\d+\.\s\[post/g) ?? []).length;
      const labels = Array.from({ length: count }, () => "GENUINE");
      return { content: [{ type: "text", text: JSON.stringify(labels) }] };
    });

    const comments = Array.from({ length: 25 }, (_, i) => ({
      commentId: `c${i}`,
      text: "hi",
      mediaCaption: null,
    }));

    const result = await classifyComments(comments);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(25);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run __tests__/triage-classify.test.ts`
Expected: FAIL — `Cannot find module '../lib/triage/classify'`

- [ ] **Step 5: Write the implementation**

```typescript
/**
 * LLM-based comment classification for triage.
 *
 * Only called for comments that did NOT match any automation keyword (see
 * keyword-scope.ts) — those are already classified as KEYWORD_MATCH for free.
 * Results are cached forever by the caller (ingest.ts persists them on the
 * TriagedComment row), so a given commentId is classified at most once.
 */

import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.TRIAGE_CLASSIFY_MODEL ?? "claude-haiku-4-5-20251001";
const BATCH_SIZE = 20;

export type ClassificationLabel = "GENUINE" | "LOW_EFFORT" | "SPAM";

export interface CommentToClassify {
  commentId: string;
  text: string;
  mediaCaption: string | null;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable is required");
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

export async function classifyComments(
  comments: CommentToClassify[]
): Promise<Map<string, ClassificationLabel>> {
  const result = new Map<string, ClassificationLabel>();
  if (comments.length === 0) return result;

  for (let i = 0; i < comments.length; i += BATCH_SIZE) {
    const batch = comments.slice(i, i + BATCH_SIZE);
    const classified = await classifyBatch(batch);
    for (const [id, label] of classified) result.set(id, label);
  }

  return result;
}

async function classifyBatch(
  batch: CommentToClassify[]
): Promise<Map<string, ClassificationLabel>> {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: buildPrompt(batch) }],
  });

  const text = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");

  return parseBatchResponse(batch, text);
}

function buildPrompt(batch: CommentToClassify[]): string {
  const lines = batch.map(
    (c, i) => `${i + 1}. [post: ${c.mediaCaption ?? "(no caption)"}] comment: "${c.text}"`
  );
  return (
    "Classify each Instagram comment below as exactly one label: GENUINE " +
    "(a real reaction, question, or opinion worth a personal reply), LOW_EFFORT " +
    '(an emoji-only or generic one-word reaction like "nice" or "🔥"), or SPAM ' +
    "(a scam, bot, or completely unrelated to the post).\n\n" +
    lines.join("\n") +
    '\n\nRespond with ONLY a JSON array of labels in the same order, e.g. ' +
    '["GENUINE","LOW_EFFORT","SPAM"]. No other text.'
  );
}

function parseBatchResponse(
  batch: CommentToClassify[],
  responseText: string
): Map<string, ClassificationLabel> {
  const result = new Map<string, ClassificationLabel>();

  let labels: unknown;
  try {
    labels = JSON.parse(responseText.trim());
  } catch {
    // Malformed response: leave these unclassified rather than guess. The
    // next sweep will see them as not-yet-in-the-table and retry.
    return result;
  }
  if (!Array.isArray(labels)) return result;

  batch.forEach((comment, i) => {
    const label = labels[i];
    if (label === "GENUINE" || label === "LOW_EFFORT" || label === "SPAM") {
      result.set(comment.commentId, label);
    }
  });

  return result;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run __tests__/triage-classify.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add lib/triage/classify.ts __tests__/triage-classify.test.ts package.json package-lock.json .env.example
git commit -m "feat: add LLM comment classification for triage"
```

---

## Task 4: Ingestion sweep

**Files:**
- Create: `lib/triage/ingest.ts`
- Test: `__tests__/triage-ingest.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockGetUserMedia, mockGetRecentMediaComments, mockDecryptToken, mockClassifyComments } =
  vi.hoisted(() => ({
    mockPrisma: {
      instagramAccount: { findMany: vi.fn() },
      triagedComment: { findMany: vi.fn(), create: vi.fn() },
    },
    mockGetUserMedia: vi.fn(),
    mockGetRecentMediaComments: vi.fn(),
    mockDecryptToken: vi.fn(),
    mockClassifyComments: vi.fn(),
  }));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", () => ({
  getUserMedia: mockGetUserMedia,
  getRecentMediaComments: mockGetRecentMediaComments,
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));
vi.mock("@/lib/triage/classify", () => ({ classifyComments: mockClassifyComments }));

import { sweepTriageComments } from "../lib/triage/ingest";

const account = {
  id: "acct_1",
  workspaceId: "ws_1",
  instagramId: "ig_1",
  accessToken: "encrypted",
  automations: [
    { id: "auto_1", postId: "media_1", matchAnyPost: false, matchAnyWord: false, keywords: ["برومبت"], wholeWordMatch: true },
  ],
};

const post = {
  id: "media_1",
  caption: "post caption",
  media_type: "VIDEO",
  timestamp: new Date().toISOString(),
  thumbnail_url: "https://example.com/thumb.jpg",
};

beforeEach(() => {
  mockPrisma.instagramAccount.findMany.mockReset();
  mockPrisma.triagedComment.findMany.mockReset();
  mockPrisma.triagedComment.create.mockReset();
  mockGetUserMedia.mockReset();
  mockGetRecentMediaComments.mockReset();
  mockDecryptToken.mockReset();
  mockClassifyComments.mockReset();

  mockPrisma.instagramAccount.findMany.mockResolvedValue([account]);
  mockGetUserMedia.mockResolvedValue([post]);
  mockDecryptToken.mockReturnValue("decrypted-token");
  mockPrisma.triagedComment.create.mockResolvedValue({});
  mockClassifyComments.mockResolvedValue(new Map());
});

describe("sweepTriageComments", () => {
  it("classifies a keyword-matching comment as KEYWORD_MATCH without calling the LLM", async () => {
    mockPrisma.triagedComment.findMany.mockResolvedValue([]);
    mockGetRecentMediaComments.mockResolvedValue([
      { id: "c1", text: "ابي البرومبت", timestamp: new Date().toISOString(), from: { id: "u1", username: "someone" } },
    ]);

    await sweepTriageComments();

    expect(mockClassifyComments).toHaveBeenCalledWith([]);
    expect(mockPrisma.triagedComment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ commentId: "c1", classification: "KEYWORD_MATCH" }),
      })
    );
  });

  it("sends only non-keyword comments to the LLM", async () => {
    mockPrisma.triagedComment.findMany.mockResolvedValue([]);
    mockGetRecentMediaComments.mockResolvedValue([
      { id: "c1", text: "ابي البرومبت", timestamp: new Date().toISOString(), from: { id: "u1" } },
      { id: "c2", text: "this changed how I think about it", timestamp: new Date().toISOString(), from: { id: "u2" } },
    ]);
    mockClassifyComments.mockResolvedValue(new Map([["c2", "GENUINE"]]));

    await sweepTriageComments();

    expect(mockClassifyComments).toHaveBeenCalledWith([
      { commentId: "c2", text: "this changed how I think about it", mediaCaption: "post caption" },
    ]);
    expect(mockPrisma.triagedComment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ commentId: "c2", classification: "GENUINE" }) })
    );
  });

  it("never re-classifies a comment already stored (cache hit)", async () => {
    mockPrisma.triagedComment.findMany.mockResolvedValue([{ commentId: "c1" }]);
    mockGetRecentMediaComments.mockResolvedValue([
      { id: "c1", text: "already seen this one", timestamp: new Date().toISOString(), from: { id: "u1" } },
    ]);

    await sweepTriageComments();

    expect(mockClassifyComments).toHaveBeenCalledWith([]);
    expect(mockPrisma.triagedComment.create).not.toHaveBeenCalled();
  });

  it("skips a comment the LLM failed to classify, without creating a row", async () => {
    mockPrisma.triagedComment.findMany.mockResolvedValue([]);
    mockGetRecentMediaComments.mockResolvedValue([
      { id: "c2", text: "unclear text", timestamp: new Date().toISOString(), from: { id: "u2" } },
    ]);
    mockClassifyComments.mockResolvedValue(new Map()); // model returned nothing usable

    await sweepTriageComments();

    expect(mockPrisma.triagedComment.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/triage-ingest.test.ts`
Expected: FAIL — `Cannot find module '../lib/triage/ingest'`

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Comment triage ingestion sweep.
 *
 * Runs independently of comment-reconciler.ts (see the plan's "Deviation from
 * spec" note) — it re-fetches the same recent comments via the same
 * read-only Graph API functions, but shares no state or control flow with the
 * DM-automation dedup/retry pipeline.
 *
 * commentId is @unique on TriagedComment, so a comment already stored is
 * simply skipped — this makes every sweep idempotent and is also what keeps
 * classification cached forever: once a row exists, it is never re-sent to
 * the LLM.
 */

import { prisma } from "@/lib/db/client";
import { getRecentMediaComments, getUserMedia, type InstagramMedia } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { matchesAnyAutomation, type AutomationScope } from "./keyword-scope";
import { classifyComments } from "./classify";

const LOOKBACK_HOURS = Number(process.env.TRIAGE_LOOKBACK_HOURS ?? 168);
const RECENT_MEDIA_LIMIT = 25;

interface TriageAccount {
  id: string;
  workspaceId: string;
  instagramId: string;
  accessToken: string;
  automations: AutomationScope[];
}

export async function sweepTriageComments(): Promise<void> {
  const accounts: TriageAccount[] = await prisma.instagramAccount.findMany({
    select: {
      id: true,
      workspaceId: true,
      instagramId: true,
      accessToken: true,
      automations: {
        where: { isActive: true },
        select: {
          id: true,
          postId: true,
          matchAnyPost: true,
          matchAnyWord: true,
          keywords: true,
          wholeWordMatch: true,
        },
      },
    },
  });

  const sinceMs = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;

  for (const account of accounts) {
    await sweepAccount(account, sinceMs).catch((error) => {
      console.error(
        `[Triage] Sweep failed for account ${account.instagramId}:`,
        error instanceof Error ? error.message : error
      );
    });
  }
}

async function sweepAccount(account: TriageAccount, sinceMs: number): Promise<void> {
  const accessToken = decryptToken(account.accessToken);

  const media = await getUserMedia(accessToken, RECENT_MEDIA_LIMIT);
  const recentMedia = media.filter((m) => Date.parse(m.timestamp) >= sinceMs);

  for (const post of recentMedia) {
    await sweepMedia(account, accessToken, post, sinceMs);
  }
}

async function sweepMedia(
  account: TriageAccount,
  accessToken: string,
  post: InstagramMedia,
  sinceMs: number
): Promise<void> {
  const comments = await getRecentMediaComments(accessToken, post.id, sinceMs);
  if (comments.length === 0) return;

  const existing = await prisma.triagedComment.findMany({
    where: { commentId: { in: comments.map((c) => c.id) } },
    select: { commentId: true },
  });
  const existingIds = new Set(existing.map((e) => e.commentId));
  const fresh = comments.filter((c) => !existingIds.has(c.id));
  if (fresh.length === 0) return;

  const keywordHitIds = new Set(
    fresh
      .filter((c) => matchesAnyAutomation(account.automations, post.id, c.text ?? ""))
      .map((c) => c.id)
  );

  const needsClassification = fresh
    .filter((c) => !keywordHitIds.has(c.id))
    .map((c) => ({
      commentId: c.id,
      text: c.text ?? "",
      mediaCaption: post.caption ?? null,
    }));
  const classifications = await classifyComments(needsClassification);

  for (const comment of fresh) {
    const classification = keywordHitIds.has(comment.id)
      ? "KEYWORD_MATCH"
      : classifications.get(comment.id);
    if (!classification) continue; // LLM failed to classify — retry next sweep

    await prisma.triagedComment
      .create({
        data: {
          workspaceId: account.workspaceId,
          instagramAccountId: account.id,
          mediaId: post.id,
          mediaThumbnailUrl: post.thumbnail_url ?? post.media_url ?? null,
          mediaCaption: post.caption ?? null,
          commentId: comment.id,
          authorUsername: comment.from?.username ?? null,
          text: comment.text ?? "",
          createdAt: new Date(comment.timestamp),
          classification,
        },
      })
      .catch(() => {}); // unique constraint race with a concurrent sweep — harmless
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/triage-ingest.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/triage/ingest.ts __tests__/triage-ingest.test.ts
git commit -m "feat: add comment triage ingestion sweep"
```

---

## Task 5: Reply / dismiss actions

**Files:**
- Create: `lib/triage/actions.ts`
- Test: `__tests__/triage-actions.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockSendCommentReply, mockDecryptToken } = vi.hoisted(() => ({
  mockPrisma: {
    triagedComment: { findFirst: vi.fn(), update: vi.fn() },
  },
  mockSendCommentReply: vi.fn(),
  mockDecryptToken: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", () => ({ sendCommentReply: mockSendCommentReply }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));

import { replyToTriagedComment, dismissTriagedComment } from "../lib/triage/actions";

beforeEach(() => {
  mockPrisma.triagedComment.findFirst.mockReset();
  mockPrisma.triagedComment.update.mockReset();
  mockSendCommentReply.mockReset();
  mockDecryptToken.mockReset();
});

describe("replyToTriagedComment", () => {
  it("posts the reply and marks the comment HANDLED", async () => {
    mockPrisma.triagedComment.findFirst.mockResolvedValue({
      id: "tc_1",
      commentId: "c1",
      instagramAccount: { accessToken: "encrypted" },
    });
    mockDecryptToken.mockReturnValue("decrypted-token");
    mockSendCommentReply.mockResolvedValue({ id: "reply_1" });

    const result = await replyToTriagedComment("ws_1", "tc_1", "Thanks!");

    expect(result).toEqual({ success: true });
    expect(mockSendCommentReply).toHaveBeenCalledWith("decrypted-token", "c1", "Thanks!");
    expect(mockPrisma.triagedComment.update).toHaveBeenCalledWith({
      where: { id: "tc_1" },
      data: expect.objectContaining({ status: "HANDLED", repliedText: "Thanks!" }),
    });
  });

  it("returns an error and does not update when the comment isn't found in this workspace", async () => {
    mockPrisma.triagedComment.findFirst.mockResolvedValue(null);

    const result = await replyToTriagedComment("ws_1", "tc_missing", "Thanks!");

    expect(result).toEqual({ success: false, error: "Comment not found" });
    expect(mockPrisma.triagedComment.update).not.toHaveBeenCalled();
  });

  it("returns an error when the comment has no Instagram account attached", async () => {
    mockPrisma.triagedComment.findFirst.mockResolvedValue({
      id: "tc_1",
      commentId: "c1",
      instagramAccount: null,
    });

    const result = await replyToTriagedComment("ws_1", "tc_1", "Thanks!");

    expect(result).toEqual({ success: false, error: "No Instagram account on this comment" });
  });
});

describe("dismissTriagedComment", () => {
  it("marks the comment DISMISSED", async () => {
    mockPrisma.triagedComment.findFirst.mockResolvedValue({ id: "tc_1" });

    const result = await dismissTriagedComment("ws_1", "tc_1");

    expect(result).toEqual({ success: true });
    expect(mockPrisma.triagedComment.update).toHaveBeenCalledWith({
      where: { id: "tc_1" },
      data: expect.objectContaining({ status: "DISMISSED" }),
    });
  });

  it("returns an error when the comment isn't found in this workspace", async () => {
    mockPrisma.triagedComment.findFirst.mockResolvedValue(null);

    const result = await dismissTriagedComment("ws_1", "tc_missing");

    expect(result).toEqual({ success: false, error: "Comment not found" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/triage-actions.test.ts`
Expected: FAIL — `Cannot find module '../lib/triage/actions'`

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Reply / dismiss actions for a triaged comment. Both are scoped to
 * workspaceId via findFirst so one workspace can never touch another's row.
 */

import { prisma } from "@/lib/db/client";
import { sendCommentReply } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";

export type TriageActionResult = { success: true } | { success: false; error: string };

export async function replyToTriagedComment(
  workspaceId: string,
  triagedCommentId: string,
  message: string
): Promise<TriageActionResult> {
  const comment = await prisma.triagedComment.findFirst({
    where: { id: triagedCommentId, workspaceId },
    include: { instagramAccount: true },
  });
  if (!comment) return { success: false, error: "Comment not found" };
  if (!comment.instagramAccount) {
    return { success: false, error: "No Instagram account on this comment" };
  }

  const accessToken = decryptToken(comment.instagramAccount.accessToken);
  await sendCommentReply(accessToken, comment.commentId, message);

  await prisma.triagedComment.update({
    where: { id: triagedCommentId },
    data: { status: "HANDLED", repliedText: message, handledAt: new Date() },
  });

  return { success: true };
}

export async function dismissTriagedComment(
  workspaceId: string,
  triagedCommentId: string
): Promise<TriageActionResult> {
  const comment = await prisma.triagedComment.findFirst({
    where: { id: triagedCommentId, workspaceId },
    select: { id: true },
  });
  if (!comment) return { success: false, error: "Comment not found" };

  await prisma.triagedComment.update({
    where: { id: triagedCommentId },
    data: { status: "DISMISSED", handledAt: new Date() },
  });

  return { success: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/triage-actions.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/triage/actions.ts __tests__/triage-actions.test.ts
git commit -m "feat: add reply/dismiss actions for comment triage"
```

---

## Task 6: API routes

**Files:**
- Create: `app/api/triage/comments/route.ts`
- Create: `app/api/triage/comments/[id]/reply/route.ts`
- Create: `app/api/triage/comments/[id]/dismiss/route.ts`

No new automated tests here — these are thin handlers over the already-tested
`lib/triage/actions.ts` and a straightforward Prisma query, matching the untested-route
pattern already used by e.g. `app/api/instagram/conversations/route.ts`. Verified by the
manual smoke test in Task 9.

- [ ] **Step 1: Write the list route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";

export const runtime = "nodejs";

export interface TriagedCommentListItem {
  id: string;
  mediaId: string;
  mediaThumbnailUrl: string | null;
  mediaCaption: string | null;
  authorUsername: string | null;
  text: string;
  createdAt: string;
  classification: string;
}

export interface TriagedCommentListResponse {
  comments: TriagedCommentListItem[];
}

// Pending comments for the workspace. `view=filtered` returns the read-only
// spot-check list (keyword hits + LLM-flagged low-effort/spam) instead of the
// main genuine-comment queue.
export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const view = request.nextUrl.searchParams.get("view") === "filtered" ? "filtered" : "pending";

  const rows = await prisma.triagedComment.findMany({
    where:
      view === "filtered"
        ? { workspaceId, status: "PENDING", classification: { not: "GENUINE" } }
        : { workspaceId, status: "PENDING", classification: "GENUINE" },
    orderBy: { createdAt: "asc" },
    take: 200,
  });

  const comments: TriagedCommentListItem[] = rows.map((r) => ({
    id: r.id,
    mediaId: r.mediaId,
    mediaThumbnailUrl: r.mediaThumbnailUrl,
    mediaCaption: r.mediaCaption,
    authorUsername: r.authorUsername,
    text: r.text,
    createdAt: r.createdAt.toISOString(),
    classification: r.classification,
  }));

  const body: { success: true; data: TriagedCommentListResponse } = {
    success: true,
    data: { comments },
  };
  return NextResponse.json(body);
}
```

- [ ] **Step 2: Write the reply route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { replyToTriagedComment } from "@/lib/triage/actions";

export const runtime = "nodejs";

type RouteProps = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteProps) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ success: false, error: "Message is required" }, { status: 400 });
  }

  const result = await replyToTriagedComment(workspaceId, id, message);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 });
  }
  return NextResponse.json({ success: true });
}
```

- [ ] **Step 3: Write the dismiss route**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { dismissTriagedComment } from "@/lib/triage/actions";

export const runtime = "nodejs";

type RouteProps = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, { params }: RouteProps) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const result = await dismissTriagedComment(workspaceId, id);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 });
  }
  return NextResponse.json({ success: true });
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/triage
git commit -m "feat: add comment triage API routes"
```

---

## Task 7: Wire the sweep into the worker

**Files:**
- Modify: `worker/dm-worker.ts`

- [ ] **Step 1: Import the sweep function**

In `worker/dm-worker.ts`, add near the top with the other imports:

```typescript
import { sweepTriageComments } from "@/lib/triage/ingest";
```

- [ ] **Step 2: Add its own interval, independent of the DM comment poll**

Inside `start()`, right after the existing `poll`/`pollTimer` block (after the line
`const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);`), add:

```typescript
  const TRIAGE_POLL_INTERVAL_MS = Number(
    process.env.TRIAGE_POLL_INTERVAL_MS ?? 5 * 60_000
  );

  async function triagePoll() {
    try {
      await sweepTriageComments();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[DM Worker] Comment triage sweep failed:", message);
    }
  }

  // Independent of the DM-automation comment poll above — see ingest.ts's
  // module comment for why these two sweeps don't share state.
  setTimeout(() => void triagePoll(), 15_000);
  const triagePollTimer = setInterval(() => void triagePoll(), TRIAGE_POLL_INTERVAL_MS);
```

- [ ] **Step 3: Clear the new interval on shutdown**

Find the `shutdown` function (starts with `async function shutdown(signal: string) {`)
and add `clearInterval(triagePollTimer);` alongside the existing `clearInterval(pollTimer);`
line.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add worker/dm-worker.ts
git commit -m "feat: run comment triage sweep in the worker process"
```

---

## Task 8: Dashboard UI — Comments page

**Files:**
- Create: `app/(dashboard)/comments/page.tsx`
- Modify: `components/sidebar.tsx`

- [ ] **Step 1: Add the nav link**

In `components/sidebar.tsx`, in the nav items array, add a new entry after `Inbox`:

```typescript
  { label: "Comments", href: "/comments" },
```

(Full array should read: Dashboard, Overview, Inbox, Comments, Campaigns, DM Logs,
Settings, Diagnostics.)

- [ ] **Step 2: Write the page**

```tsx
"use client";

/**
 * Comments — triage queue for genuine audience comments.
 *
 * Unlike Instagram's own activity feed, this list never reorders or resets
 * scroll: polling only prepends newly-ingested rows, and replying/dismissing
 * removes exactly the one row acted on. Filtered-out comments (CTA keyword
 * hits, LLM-flagged low-effort/spam) are not shown here by default — see the
 * "Filtered" toggle.
 */

import { useCallback, useEffect, useState } from "react";
import type { TriagedCommentListItem } from "@/app/api/triage/comments/route";

const POLL_MS = 30_000;

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function CommentsPage() {
  const [view, setView] = useState<"pending" | "filtered">("pending");
  const [comments, setComments] = useState<TriagedCommentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const res = await fetch(`/api/triage/comments?view=${view}`, { cache: "no-store" });
        const data = await res.json();
        if (data.success) {
          setComments(data.data.comments);
          setError(null);
        } else if (!silent) {
          setError(data.error ?? "Failed to load comments");
        }
      } catch {
        if (!silent) setError("Failed to load comments");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [view]
  );

  useEffect(() => {
    setComments([]);
    void load(false);
    const timer = window.setInterval(() => void load(true), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  async function handleReply(id: string) {
    const message = (drafts[id] ?? "").trim();
    if (!message || busyId) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/triage/comments/${id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      if (data.success) {
        setComments((prev) => prev.filter((c) => c.id !== id));
        setDrafts((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      } else {
        setError(data.error ?? "Failed to send reply");
      }
    } catch {
      setError("Failed to send reply");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDismiss(id: string) {
    if (busyId) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/triage/comments/${id}/dismiss`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setComments((prev) => prev.filter((c) => c.id !== id));
      } else {
        setError(data.error ?? "Failed to dismiss");
      }
    } catch {
      setError("Failed to dismiss");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold text-foreground">Comments</h1>
        <div className="flex gap-2 text-sm">
          <button
            type="button"
            onClick={() => setView("pending")}
            className={`rounded px-3 py-1.5 ${
              view === "pending" ? "bg-accent text-white" : "border border-border text-muted"
            }`}
          >
            To reply
          </button>
          <button
            type="button"
            onClick={() => setView("filtered")}
            className={`rounded px-3 py-1.5 ${
              view === "filtered" ? "bg-accent text-white" : "border border-border text-muted"
            }`}
          >
            Filtered
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-error">{error}</p>}

      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted">
          {view === "pending" ? "No comments waiting on you." : "Nothing filtered."}
        </p>
      ) : (
        <div className="space-y-3">
          {comments.map((c) => (
            <div key={c.id} className="rounded border border-border p-4">
              <div className="flex items-start gap-3">
                {c.mediaThumbnailUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={c.mediaThumbnailUrl}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded object-cover"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">
                      @{c.authorUsername ?? "unknown"}
                    </span>
                    <span className="shrink-0 text-[11px] text-zinc-500">
                      {formatTime(c.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-foreground">{c.text}</p>
                  {view === "filtered" && (
                    <span className="mt-1 inline-block text-[11px] uppercase tracking-wide text-zinc-500">
                      {c.classification}
                    </span>
                  )}
                </div>
              </div>

              {view === "pending" && (
                <div className="mt-3 flex items-end gap-2">
                  <textarea
                    value={drafts[c.id] ?? ""}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                    rows={1}
                    placeholder="Write a reply…"
                    className="max-h-32 min-h-[40px] flex-1 resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleReply(c.id)}
                    disabled={busyId === c.id || !(drafts[c.id] ?? "").trim()}
                    className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                  >
                    Reply
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDismiss(c.id)}
                    disabled={busyId === c.id}
                    className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:text-foreground disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add "app/(dashboard)/comments/page.tsx" components/sidebar.tsx
git commit -m "feat: add Comments triage page to dashboard"
```

---

## Task 9: Manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Set the env var locally**

Add a real `ANTHROPIC_API_KEY` to your local `.env` (not `.env.example`).

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass, including the new `triage-*.test.ts` files.

- [ ] **Step 3: Start the worker and watch one sweep**

Run: `npm run worker`
Expected: within ~15s, a log line or no error from the triage sweep. Check
`prisma.triagedComment` rows exist after a few minutes:

```bash
npx prisma studio
```

Open the `TriagedComment` table and confirm rows are appearing with a mix of
`KEYWORD_MATCH` and LLM-assigned classifications.

- [ ] **Step 4: Start the dashboard and check the page**

Run: `npm run dev`

Visit `http://localhost:3000/comments`. Confirm:
- The "To reply" tab shows only `GENUINE` comments.
- The "Filtered" tab shows keyword/low-effort/spam comments, read-only.
- Replying to a comment removes it from the list and the reply appears on
  Instagram under that comment within a few seconds.
- Dismissing a comment removes it from the list without posting anything.

- [ ] **Step 5: Final commit if any fixes were needed during smoke test**

```bash
git add -A
git commit -m "fix: address issues found in comment triage smoke test"
```
