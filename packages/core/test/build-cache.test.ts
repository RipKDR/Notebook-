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

  it("is stable across compiles, which is what makes rebuilds incremental", () => {
    // Recomputed from the same inputs on a later run, the key must be identical.
    // It previously folded in the previous scene's prose and the continuity
    // ledger — both empty on a first compile and populated on the next — which
    // changed every key on the second run and rebuilt the entire book.
    const first = sceneKey(base);
    const second = sceneKey({
      card: card(),
      bibleVersion: 1,
      fragments: [fragment("f1", "She never once said my name.")],
    });
    expect(second).toBe(first);
  });

  it("ignores the scene card's index, which carries no drafting information", () => {
    expect(sceneKey({ ...base, card: card({ index: 7 }) })).toBe(sceneKey(base));
  });
});

describe("dirtyScenes", () => {
  const ordered = (pairs: [string, string][]) => pairs.map(([id, key]) => ({ id, key }));

  it("builds nothing when every key has already been built", () => {
    const scenes = ordered([["a", "1"], ["b", "2"], ["c", "3"], ["d", "4"]]);
    const built = new Set(["1", "2", "3", "4"]);
    expect(dirtyScenes(scenes, built).size).toBe(0);
  });

  it("rebuilds a changed scene and cascades one forward", () => {
    const scenes = ordered([["a", "1"], ["b", "CHANGED"], ["c", "3"], ["d", "4"]]);
    const built = new Set(["1", "2", "3", "4"]);
    expect([...dirtyScenes(scenes, built)].sort()).toEqual(["b", "c"]);
  });

  it("rebuilds everything on a first compile", () => {
    const scenes = ordered([["a", "1"], ["b", "2"]]);
    expect(dirtyScenes(scenes, new Set()).size).toBe(2);
  });

  it("reuses prose under a new scene id when the content key matches", () => {
    // A regenerated outline renames every scene. Matching on content rather than
    // identity is what stops that rebuilding the whole book.
    const renamed = ordered([["fresh-id-1", "1"], ["fresh-id-2", "2"]]);
    expect(dirtyScenes(renamed, new Set(["1", "2"])).size).toBe(0);
  });

  it("honours a wider cascade limit", () => {
    const scenes = ordered([["a", "CHANGED"], ["b", "2"], ["c", "3"], ["d", "4"]]);
    const built = new Set(["1", "2", "3", "4"]);
    expect([...dirtyScenes(scenes, built, 2)].sort()).toEqual(["a", "b", "c"]);
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
