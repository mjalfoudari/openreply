/**
 * The only genuinely new logic in the "Meta errored but it landed" fix. dm-worker.test.ts
 * mocks this function away, so without this file the predicate that decides whether a real
 * person is marked as served ships untested.
 *
 * A false `true` here is permanent: comment-reconciler drops that commenterId from every
 * future sweep, and delivery-health drops them from the never-received list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { wasMessageDelivered } from "@/lib/meta/client";

const US = "17841400000000000";
const THEM = "9876543210";
const NOW = Date.now();

function conversations(rows: unknown[]) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: rows }),
  })) as unknown as typeof fetch;
}

function thread(fromId: string, atMs: number, participants = [US, THEM]) {
  return {
    id: "conv_1",
    participants: { data: participants.map((id) => ({ id })) },
    messages: {
      data: [{ id: "m1", from: { id: fromId }, created_time: new Date(atMs).toISOString() }],
    },
  };
}

beforeEach(() => vi.stubGlobal("fetch", conversations([])));
afterEach(() => vi.unstubAllGlobals());

describe("wasMessageDelivered", () => {
  it("says yes when OUR message sits in the window", async () => {
    vi.stubGlobal("fetch", conversations([thread(US, NOW + 400)]));
    expect(await wasMessageDelivered("t", US, THEM, NOW)).toBe(true);
  });

  it("says NO when the newest message is from the recipient", async () => {
    // The campaign copy tells people to check their DMs; "لم استلم اي شي" lands here.
    vi.stubGlobal("fetch", conversations([thread(THEM, NOW + 400)]));
    expect(await wasMessageDelivered("t", US, THEM, NOW)).toBe(false);
  });

  // If the only thread returned is not theirs, Graph ignored the user_id filter and we
  // cannot tell — that is UNKNOWN, not a known negative. Both answers route to the same
  // FAILED path today, but a future caller might read `false` as "safe to resend", and
  // resending on a guess is what put five copies in one person's inbox.
  it("says UNKNOWN when the only thread returned is somebody else's", async () => {
    vi.stubGlobal("fetch", conversations([thread(US, NOW + 400, [US, "someone_else"])]));
    expect(await wasMessageDelivered("t", US, THEM, NOW)).toBeNull();
  });

  it("finds the recipient's thread even when it is not first", async () => {
    vi.stubGlobal(
      "fetch",
      conversations([thread(US, NOW + 400, [US, "someone_else"]), thread(US, NOW + 400)])
    );
    expect(await wasMessageDelivered("t", US, THEM, NOW)).toBe(true);
  });

  it("says NO for a message that predates the attempt", async () => {
    vi.stubGlobal("fetch", conversations([thread(US, NOW - 60_000)]));
    expect(await wasMessageDelivered("t", US, THEM, NOW)).toBe(false);
  });

  it("says NO when `from` is missing (unresolvable sender is not us)", async () => {
    const t = thread(US, NOW + 400);
    delete (t.messages.data[0] as { from?: unknown }).from;
    vi.stubGlobal("fetch", conversations([t]));
    expect(await wasMessageDelivered("t", US, THEM, NOW)).toBe(false);
  });

  it("returns null (unknown) for an anonymised commenter id", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await wasMessageDelivered("t", US, "anon_17914", NOW)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns null (unknown), never false, when the check itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: { code: 190, message: "token expired" } }),
      })) as unknown as typeof fetch
    );
    expect(await wasMessageDelivered("t", US, THEM, NOW)).toBeNull();
  });
});
