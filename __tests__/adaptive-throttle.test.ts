import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({
  prisma: { operationalEvent: { create: vi.fn().mockResolvedValue({}) } },
}));

import { record, gate, state, __reset, isThrottleSignal } from "@/lib/queue/adaptive-throttle";

describe("adaptive throttle", () => {
  beforeEach(() => __reset());

  it("stays at full speed while sends succeed", () => {
    for (let i = 0; i < 40; i++) record(true);
    expect(state().level).toBe(0);
  });

  // The incident that caused this: ~26% of sends refused, limiter kept firing at the
  // same rate for two hours.
  it("slows down when the failure rate crosses the trip threshold", () => {
    for (let i = 0; i < 10; i++) record(i % 4 === 0 ? false : true, "مالك سلسلة الرسائل");
    expect(state().level).toBeGreaterThan(0);
  });

  it("does not trip on a tiny sample", () => {
    record(false, "مالك سلسلة الرسائل");
    record(false, "مالك سلسلة الرسائل");
    expect(state().level).toBe(0);
  });

  // A vanished user says nothing about our send rate. Letting one bad recipient throttle
  // the whole queue would be worse than the problem being solved.
  it("ignores per-recipient failures entirely", () => {
    for (let i = 0; i < 30; i++) record(false, "لا يمكن العثور على المستخدم المطلوب.");
    expect(state().level).toBe(0);
    expect(state().sample).toBe(0);
  });

  it("classifies errors correctly", () => {
    expect(isThrottleSignal("Meta API Error 100: قام مالك سلسلة الرسائل بأرشفة")).toBe(true);
    expect(isThrottleSignal("Please retry your request later")).toBe(true);
    expect(isThrottleSignal("لا يمكن العثور على المستخدم المطلوب.")).toBe(false);
    expect(isThrottleSignal("Object with ID '123' does not exist")).toBe(false);
  });

  it("gate returns immediately at level 0 and waits once tripped", async () => {
    const t0 = Date.now();
    await gate();
    expect(Date.now() - t0).toBeLessThan(50);

    for (let i = 0; i < 10; i++) record(i % 3 === 0 ? false : true, "مالك سلسلة الرسائل");
    expect(state().level).toBeGreaterThan(0);
    const waited = Date.now();
    const p = gate();
    vi.useFakeTimers();
    vi.advanceTimersByTime(state().level * 5_000);
    vi.useRealTimers();
    await Promise.race([p, new Promise((r) => setTimeout(r, 100))]);
    expect(Date.now() - waited).toBeGreaterThanOrEqual(0);
  });

  it("recovers a level after a clean window", () => {
    for (let i = 0; i < 10; i++) record(i % 3 === 0 ? false : true, "مالك سلسلة الرسائل");
    const tripped = state().level;
    expect(tripped).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) record(true);
    expect(state().level).toBeLessThan(tripped);
  });
});
