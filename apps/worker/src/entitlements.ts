/**
 * Entitlements — what a given account is allowed to spend.
 *
 * We hold the API key and pay for generation, so this is the layer that keeps a
 * subscription from becoming an unbounded liability. A full-length compile costs
 * us real money in model tokens; without a ceiling, a single user with a script
 * could run the monthly margin of a hundred subscribers in an afternoon.
 *
 * The budget is passed to the compiler, which aborts cleanly when it is
 * exhausted rather than silently producing a half-book.
 */

export type Tier = "free" | "paid";

export interface Entitlement {
  readonly tier: Tier;
  /** Hard ceiling on model spend for one compile, in USD. */
  readonly budgetUsd: number;
  /** Full compiles included per billing period. */
  readonly compilesPerPeriod: number;
  /** Whether the revision passes run. Skipping them roughly halves cost and time. */
  readonly revision: boolean;
  readonly maxTargetWords: number;
  readonly cloudSync: boolean;
}

/**
 * A 100k-word compile measures out at roughly $7.50 of model spend: Bible and
 * outline on the most capable model, ~80 batched scene calls at half price with
 * a cached prefix, and four revision passes. The ceiling here is set well above
 * that so an unusually dense notebook does not fail halfway, while still being a
 * ceiling.
 */
export const ENTITLEMENTS: Record<Tier, Entitlement> = {
  free: {
    tier: "free",
    // Enough for a real sample — a Bible, an outline and a few chapters — so the
    // free tier demonstrates the product rather than describing it.
    budgetUsd: 0.75,
    compilesPerPeriod: 1,
    revision: false,
    maxTargetWords: 15_000,
    cloudSync: false,
  },
  paid: {
    tier: "paid",
    budgetUsd: 14.0,
    compilesPerPeriod: 2,
    revision: true,
    maxTargetWords: 160_000,
    cloudSync: true,
  },
};

export interface Usage {
  readonly compilesThisPeriod: number;
  readonly periodResetsAt: number;
}

export type Decision =
  | { allowed: true; entitlement: Entitlement; targetWords: number }
  | { allowed: false; reason: string; code: "quota" | "tier" };

export function authorise(
  tier: Tier,
  usage: Usage,
  requestedWords: number,
): Decision {
  const entitlement = ENTITLEMENTS[tier];

  if (usage.compilesThisPeriod >= entitlement.compilesPerPeriod) {
    const days = Math.max(1, Math.ceil((usage.periodResetsAt - Date.now()) / 86_400_000));
    return {
      allowed: false,
      code: "quota",
      reason:
        tier === "free"
          ? `Your free compile has been used. Upgrade for full-length books, or wait ${days} more ${days === 1 ? "day" : "days"}.`
          : `You have used this period's compiles. More reset in ${days} ${days === 1 ? "day" : "days"}, or buy credits.`,
    };
  }

  // Clamp rather than reject: a free user asking for a novel gets a real book's
  // opening rather than an error, which is a far better argument for upgrading.
  return {
    allowed: true,
    entitlement,
    targetWords: Math.min(requestedWords, entitlement.maxTargetWords),
  };
}
