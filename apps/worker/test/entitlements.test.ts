import { describe, expect, it } from "vitest";
import { authorise, ENTITLEMENTS } from "../src/entitlements.js";

const fresh = { compilesThisPeriod: 0, periodResetsAt: Date.now() + 86_400_000 * 10 };

describe("authorise", () => {
  it("lets a paid user compile a full-length novel", () => {
    const decision = authorise("paid", fresh, 100_000);
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.targetWords).toBe(100_000);
      expect(decision.entitlement.revision).toBe(true);
    }
  });

  it("clamps a free user's target rather than rejecting them", () => {
    const decision = authorise("free", fresh, 100_000);
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.targetWords).toBe(ENTITLEMENTS.free.maxTargetWords);
      expect(decision.entitlement.revision).toBe(false);
    }
  });

  it("does not inflate a target below the tier ceiling", () => {
    const decision = authorise("paid", fresh, 5_000);
    expect(decision.allowed && decision.targetWords).toBe(5_000);
  });

  it("refuses once the period quota is used", () => {
    const used = { compilesThisPeriod: 1, periodResetsAt: Date.now() + 86_400_000 * 3 };
    const decision = authorise("free", used, 10_000);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("quota");
      expect(decision.reason).toMatch(/upgrade/i);
    }
  });

  it("tells a paid user when their quota resets", () => {
    const used = { compilesThisPeriod: 2, periodResetsAt: Date.now() + 86_400_000 * 5 };
    const decision = authorise("paid", used, 100_000);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toMatch(/\d+ days?/);
  });

  it("keeps the paid budget above the measured cost of a full compile", () => {
    // A 100k-word compile measures at roughly $7.50. The ceiling has to leave
    // real headroom for a dense notebook, or compiles fail at 90%.
    expect(ENTITLEMENTS.paid.budgetUsd).toBeGreaterThan(7.5 * 1.5);
  });

  it("keeps the free budget small enough to be given away", () => {
    expect(ENTITLEMENTS.free.budgetUsd).toBeLessThan(1);
  });

  it("gates cloud sync to the paid tier", () => {
    expect(ENTITLEMENTS.free.cloudSync).toBe(false);
    expect(ENTITLEMENTS.paid.cloudSync).toBe(true);
  });
});
