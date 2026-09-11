import { describe, expect, it } from "vitest";
import { dirtyScenes, sceneKey, tailOf, changedSince } from "../src/cache/content-address.js";
import type { SceneCard } from "../src/types/outline.js";
import type { Fragment } from "../src/types/fragment.js";
import { asChapterId, asFragmentId, asSceneId } from "../src/types/ids.js";

function card(overrides: Partial<SceneCard> = {}): SceneCard {
  return {
    id: asSceneId("scene-1"),
    chapterId: asChapterId("ch-1"),
    index: 0,
    goal: "Mara finds the letter",
    pov: null,
    setting: "The attic",
    present: [],
    enteringState: "Mara is sorting boxes",
    exitingState: "Mara has read the letter",
    fragmentIds: [asFragmentId("f1")],
    targetWords: 1200,
    valence: -0.3,
    motifs: ["dust"],
    ...overrides,
  };
}

function fragment(id: string, text: string, updatedAt = 1000): Fragment {
  return {
    id: asFragmentId(id),
    projectId: null,
    text,
    createdAt: updatedAt,
    updatedAt,
    source: "quick",
    deletedAt: null,
    pinned: false,
    enrichment: null,
    embedding: null,
  };
}

const base = {
  card: card(),
  bibleVersion: 1,
  fragments: [fragment("f1", "She never once said my name.")],
  prevTailHash: "tail",
  ledgerHash: "ledger",
};

describe("sceneKey", () => {
  it("is stable across identical inputs", () => {
    expect(sceneKey(base)).toBe(sceneKey({ ...base }));
  });

  it("is insensitive to the order fragments arrive in", () => {
    const two = [fragment("f1", "one"), fragment("f2", "two")];
    const a = sceneKey({ ...base, fragments: two });
    const b = sceneKey({ ...base, fragments: [...two].reverse() });
    expect(a).toBe(b);
  });

  it("changes when the Bible version changes", () => {
    expect(sceneKey({ ...base, bibleVersion: 2 })).not.toBe(sceneKey(base));
  });

  it("changes when a fragment's text is edited", () => {
    expect(
      sceneKey({ ...base, fragments: [fragment("f1", "She said my name once.")] }),
    ).not.toBe(sceneKey(base));
  });

  it("changes when the scene card's goal changes", () => {
    expect(sceneKey({ ...base, card: card({ goal: "Mara burns the letter" }) })).not.toBe(
      sceneKey(base),
    );
  });

  it("changes when the preceding scene's prose changes", () => {
    expect(sceneKey({ ...base, prevTailHash: "different" })).not.toBe(sceneKey(base));
  });

  it("ignores the scene card's index, which carries no drafting information", () => {
    expect(sceneKey({ ...base, card: card({ index: 7 }) })).toBe(sceneKey(base));
  });
});

describe("dirtyScenes", () => {
  const order = ["a", "b", "c", "d"];

  it("rebuilds nothing when every key matches", () => {
    const keys = new Map([["a", "1"], ["b", "2"], ["c", "3"], ["d", "4"]]);
    expect(dirtyScenes(keys, keys, order).size).toBe(0);
  });

  it("rebuilds a changed scene and cascades one forward", () => {
    const prev = new Map([["a", "1"], ["b", "2"], ["c", "3"], ["d", "4"]]);
    const now = new Map([["a", "1"], ["b", "CHANGED"], ["c", "3"], ["d", "4"]]);
    expect([...dirtyScenes(now, prev, order)].sort()).toEqual(["b", "c"]);
  });

  it("rebuilds everything on a first compile", () => {
    const now = new Map([["a", "1"], ["b", "2"]]);
    expect(dirtyScenes(now, new Map(), ["a", "b"]).size).toBe(2);
  });

  it("treats a new scene as dirty", () => {
    const prev = new Map([["a", "1"]]);
    const now = new Map([["a", "1"], ["b", "2"]]);
    expect([...dirtyScenes(now, prev, ["a", "b"])]).toEqual(["b"]);
  });

  it("honours a wider cascade limit", () => {
    const prev = new Map([["a", "1"], ["b", "2"], ["c", "3"], ["d", "4"]]);
    const now = new Map([["a", "CHANGED"], ["b", "2"], ["c", "3"], ["d", "4"]]);
    expect([...dirtyScenes(now, prev, order, 2)].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("tailOf", () => {
  it("cuts on a paragraph boundary rather than mid-sentence", () => {
    const prose = "First para, quite long and full of words.\n\nSecond para here.";
    expect(tailOf(prose, 3)).toBe("Second para here.");
  });

  it("keeps paragraph breaks in a multi-paragraph tail", () => {
    const prose = "One.\n\nTwo two two.\n\nThree three three.";
    expect(tailOf(prose, 5)).toContain("\n\n");
  });

  it("returns the whole prose when it is shorter than the target", () => {
    expect(tailOf("Short.", 100)).toBe("Short.");
  });

  it("returns empty for empty prose", () => {
    expect(tailOf("   ", 10)).toBe("");
  });
});

describe("changedSince", () => {
  it("finds edited and newly deleted fragments", () => {
    const frags = [
      fragment("old", "untouched", 500),
      fragment("edited", "changed", 2000),
      { ...fragment("gone", "removed", 500), deletedAt: 3000 },
    ];
    expect(changedSince(frags, 1000).sort()).toEqual(["edited", "gone"]);
  });
});
