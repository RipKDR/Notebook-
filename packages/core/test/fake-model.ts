import type { z } from "zod";
import type {
  BatchLike,
  BatchOptions,
  BatchRequest,
  BatchResult,
  CallSpec,
  LlmLike,
  TokenUsage,
} from "../src/index.js";

/**
 * A deterministic stand-in for the model, for running the compiler end-to-end
 * with no network and no credential.
 *
 * The important property is that it validates its own output against the real
 * schema before returning it. A fake that returns whatever the next stage
 * happens to accept tests nothing; this one fails loudly if a stage's schema and
 * the data flowing into it ever disagree, which is exactly the class of bug that
 * unit-testing stages in isolation cannot reach.
 *
 * It is not a quality model — the prose it emits is filler. It is a wiring test.
 */

const usage: TokenUsage = {
  inputTokens: 1000,
  outputTokens: 400,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export interface FakeCall {
  readonly stage: string;
  readonly systemBytes: number;
  readonly userBytes: number;
}

export class FakeLlm implements LlmLike {
  readonly calls: FakeCall[] = [];
  /** Every distinct system prompt seen per stage — the cache-stability check. */
  readonly systemsByStage = new Map<string, Set<string>>();

  async prose(spec: CallSpec): Promise<{ text: string; usage: TokenUsage }> {
    this.record(spec);
    return { text: filler(600), usage };
  }

  async structured<T extends z.ZodType>(
    spec: CallSpec,
    schema: T,
  ): Promise<{ value: z.infer<T>; usage: TokenUsage }> {
    this.record(spec);
    const raw = this.respond(spec);
    // Validate against the real schema. If a stage's schema rejects plausible
    // data, that is a bug in the schema and the test should surface it here.
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `FakeLlm output rejected by the real schema at stage "${spec.stage}":\n` +
          JSON.stringify(parsed.error.issues.slice(0, 6), null, 2),
      );
    }
    return { value: parsed.data as z.infer<T>, usage };
  }

  private record(spec: CallSpec): void {
    this.calls.push({
      stage: spec.stage,
      systemBytes: spec.system.length,
      userBytes: spec.user.length,
    });
    const seen = this.systemsByStage.get(spec.stage) ?? new Set<string>();
    seen.add(spec.system);
    this.systemsByStage.set(spec.stage, seen);
  }

  private respond(spec: CallSpec): unknown {
    switch (spec.stage) {
      case "enrich":
        return { items: enrichItems(spec.user) };
      case "bible":
        return bible(spec.system);
      case "outline:plan":
        return plan(spec.user);
      case "outline:expand":
        return expand(spec.user);
      case "ledger":
        return { deltas: [{ kind: "knowledge", subjects: ["person:nan"], statement: "A thing is now known." }] };
      case "revise:audit":
        return {
          issues: [
            {
              sceneIndex: 2,
              severity: "noticeable",
              description: "A date given in scene 1 contradicts scene 2.",
              fix: "Change the year in scene 2 to match.",
            },
          ],
          assessment: "Broadly coherent.",
        };
      case "revise:payoff":
        return { unpaidSetups: [], unpreparedPayoffs: [], assessment: "Balanced." };
      default:
        throw new Error(`FakeLlm has no response for stage "${spec.stage}"`);
    }
  }
}

export class FakeBatch implements BatchLike {
  readonly stages: string[] = [];
  readonly requestCounts = new Map<string, number>();
  /** Distinct system prompts per stage. Drafting must show exactly one. */
  readonly systemsByStage = new Map<string, Set<string>>();

  async run(
    requests: readonly BatchRequest[],
    opts: BatchOptions,
  ): Promise<Map<string, BatchResult>> {
    this.stages.push(opts.stage);
    this.requestCounts.set(opts.stage, (this.requestCounts.get(opts.stage) ?? 0) + requests.length);

    const seen = this.systemsByStage.get(opts.stage) ?? new Set<string>();
    for (const r of requests) seen.add(r.system);
    this.systemsByStage.set(opts.stage, seen);

    const out = new Map<string, BatchResult>();
    for (const request of requests) {
      // Echo the assigned fragment text back into the prose so the pipeline's
      // own "did my notes make it in" detection has something real to find.
      const quoted = [...request.user.matchAll(/^\[\d+\] \((?:[a-z]+), id=[^)]+\)\n(.+)$/gm)]
        .map((m) => m[1]!)
        .join(" ");

      out.set(request.customId, {
        customId: request.customId,
        ok: true,
        text: `${quoted} ${filler(500)}`.trim(),
        usage,
        costUsd: 0.01,
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------

function filler(words: number): string {
  const sentence = "The room was quiet and the light came in sideways through the blinds. ";
  const paragraphs: string[] = [];
  let produced = 0;
  while (produced < words) {
    const size = Math.min(60, words - produced);
    paragraphs.push(sentence.repeat(Math.ceil(size / 13)).trim());
    produced += size;
  }
  return paragraphs.join("\n\n");
}

function enrichItems(user: string): unknown[] {
  const count = user.split("\n---\n").length;
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    kind: i % 3 === 0 ? "memory" : i % 3 === 1 ? "scene" : "aphorism",
    digest: `Digest for fragment ${i + 1}`,
    entities: [{ surface: "Nan", canonical: "Nan", kind: "person" }],
    themes: ["family", "memory"],
    valence: -0.2,
    standalone: 0.7,
  }));
}

function bible(system: string): unknown {
  const isMemoir = system.includes("memoir");
  return {
    title: "The Kitchen Radio",
    logline: "A woman sorts her grandmother's house and finds she did not know her.",
    entities: [
      {
        id: "person:nan",
        name: "Nan",
        kind: "person",
        aliases: ["grandmother"],
        description: "The narrator's grandmother. Kept everything, explained nothing.",
        initialState: "Recently dead; her house not yet cleared.",
      },
    ],
    themes: [
      {
        name: "Inheritance",
        statement: "What we are left is not what we were given.",
        motifs: ["the radio", "biscuit tins"],
      },
    ],
    voice: {
      description: "Plain, unhurried, concrete. Short declaratives.",
      exemplars: [
        "She never once said my name.",
        "The kitchen radio was always on, even when nobody was listening to it.",
        "I have no memory of the drive home, only of arriving.",
      ],
      avoid: ["Rhetorical tricolons", "Summarising the emotion of a scene"],
      person: "first",
      tense: "past",
    },
    formBible: isMemoir
      ? {
          form: "memoir",
          governingQuestion: "Did I ever know her, or only the version she performed?",
          retrospectiveStance: "The narrator now suspects the silence was deliberate.",
          timeSpan: { earliest: "childhood", latest: "the year of the funeral" },
          sensitiveEntityIds: ["person:nan"],
          throughLine: "Objects outlasting the people who explained them.",
        }
      : {
          form: "fiction",
          premise: "A woman clearing a house discovers her grandmother's second family.",
          protagonistId: "person:nan",
          want: "To finish clearing the house and leave.",
          need: "To stop mistaking silence for peace.",
          centralConflict: "Every room contradicts the story she was told.",
          worldRules: ["No one still living can confirm anything."],
          stakes: "The last version of her grandmother she can bear to keep.",
        },
  };
}

/** Allocates every fragment the planner was shown across three chapters. */
function plan(user: string): unknown {
  const ids = [...user.matchAll(/^- ([0-9A-HJKMNP-TV-Z]{26}) \[/gm)].map((m) => m[1]!);
  const chapters = [0, 1, 2].map((i) => ({
    title: `Chapter ${i + 1}`,
    summary: `What happens in chapter ${i + 1}.`,
    part: i === 0 ? "Part One: The Question" : i === 1 ? "Part Two: The Evidence" : "Part Three: The Reckoning",
    targetWords: 4000,
    fragmentIds: ids.filter((_, n) => n % 3 === i),
  }));
  return { chapters, unusedFragments: [] };
}

/** Distributes the chapter's fragments across two scenes, using every one. */
function expand(user: string): unknown {
  const ids = [...user.matchAll(/^\[([0-9A-HJKMNP-TV-Z]{26})\] \(/gm)].map((m) => m[1]!);
  const half = Math.ceil(ids.length / 2);
  const buckets = [ids.slice(0, half), ids.slice(half)];

  return {
    scenes: buckets.map((bucket, i) => ({
      goal: `Scene ${i + 1} does its work.`,
      pov: "person:nan",
      setting: "The kitchen",
      present: ["person:nan"],
      enteringState: `State before scene ${i + 1}.`,
      exitingState: `State after scene ${i + 1}.`,
      fragmentIds: bucket,
      targetWords: 2000,
      valence: i === 0 ? -0.3 : 0.2,
      motifs: ["the radio"],
    })),
  };
}
