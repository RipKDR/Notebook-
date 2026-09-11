import { describe, expect, it } from "vitest";
import { UsageStore } from "../src/usage.js";

describe("UsageStore", () => {
  it("starts an account at zero", () => {
    const store = UsageStore.open(":memory:");
    expect(store.read("a").compilesThisPeriod).toBe(0);
  });

  it("counts reservations", () => {
    const store = UsageStore.open(":memory:");
    expect(store.reserve("a", 2)).toBe(true);
    expect(store.read("a").compilesThisPeriod).toBe(1);
    expect(store.reserve("a", 2)).toBe(true);
    expect(store.read("a").compilesThisPeriod).toBe(2);
  });

  it("refuses a reservation past the limit", () => {
    const store = UsageStore.open(":memory:");
    expect(store.reserve("a", 1)).toBe(true);
    expect(store.reserve("a", 1)).toBe(false);
    expect(store.read("a").compilesThisPeriod).toBe(1);
  });

  it("checks and increments atomically, so a race cannot overspend", () => {
    // Both callers would read "0 used" if the check were a separate statement.
    const store = UsageStore.open(":memory:");
    const results = [store.reserve("a", 1), store.reserve("a", 1)];
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("returns a reservation when a job fails to start", () => {
    const store = UsageStore.open(":memory:");
    store.reserve("a", 2);
    store.release("a");
    expect(store.read("a").compilesThisPeriod).toBe(0);
  });

  it("never releases below zero", () => {
    const store = UsageStore.open(":memory:");
    store.release("a");
    store.release("a");
    expect(store.read("a").compilesThisPeriod).toBe(0);
  });

  it("keeps accounts separate", () => {
    const store = UsageStore.open(":memory:");
    store.reserve("a", 5);
    expect(store.read("b").compilesThisPeriod).toBe(0);
  });

  it("resets in the next billing period", () => {
    const store = UsageStore.open(":memory:");
    const now = Date.now();
    store.reserve("a", 1, now);
    expect(store.read("a", now).compilesThisPeriod).toBe(1);

    const nextPeriod = store.read("a", now).periodResetsAt + 1000;
    expect(store.read("a", nextPeriod).compilesThisPeriod).toBe(0);
    expect(store.reserve("a", 1, nextPeriod)).toBe(true);
  });

  it("accumulates recorded spend", () => {
    const store = UsageStore.open(":memory:");
    store.recordSpend("a", 7.5);
    store.recordSpend("a", 2.25);
    expect(store.spentThisPeriod("a")).toBeCloseTo(9.75, 5);
  });

  it("survives a restart, so a crash cannot hand out an extra book", () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/loom-usage-test-${Date.now()}.db`;
    const first = UsageStore.open(path);
    expect(first.reserve("a", 1)).toBe(true);
    first.close();

    const second = UsageStore.open(path);
    expect(second.read("a").compilesThisPeriod).toBe(1);
    expect(second.reserve("a", 1)).toBe(false);
    second.close();
  });
});
