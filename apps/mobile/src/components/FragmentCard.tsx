import type { Fragment } from "@loom/core";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { countWords, relativeTime } from "@/lib/format";
import { fonts, radius, spacing, type, usePalette } from "@/theme";

/**
 * A fragment, as the user sees it.
 *
 * Their words are set in the prose serif and given the room to breathe; our
 * metadata is small, quiet and sans-serif. The kind chip only appears once the
 * indexer has classified the note — showing "unclassified" would advertise a
 * background process the user did not ask about and cannot act on.
 */

const KIND_LABELS: Record<string, string> = {
  scene: "Scene",
  dialogue: "Dialogue",
  character: "Person",
  setting: "Place",
  premise: "Idea",
  theme: "Theme",
  aphorism: "Line",
  memory: "Memory",
  reflection: "Reflection",
  fragmentary: "Fragment",
};

export function FragmentCard({
  fragment,
  onPress,
  numberOfLines = 6,
  showMeta = true,
}: {
  fragment: Fragment;
  onPress?: () => void;
  numberOfLines?: number;
  showMeta?: boolean;
}) {
  const palette = usePalette();
  const kind = fragment.enrichment?.kind;

  return (
    <Pressable
      onPress={onPress}
      disabled={onPress === undefined}
      accessibilityRole={onPress ? "button" : "text"}
      accessibilityLabel={fragment.text.slice(0, 120)}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: palette.surface,
          borderColor: palette.border,
          opacity: pressed && onPress ? 0.7 : 1,
        },
      ]}
    >
      <Text
        numberOfLines={numberOfLines}
        style={[styles.text, { color: palette.ink, fontFamily: fonts.prose }]}
      >
        {fragment.text}
      </Text>

      {showMeta ? (
        <View style={styles.meta}>
          {kind !== undefined ? (
            <View style={[styles.chip, { backgroundColor: palette.accentSoft }]}>
              <Text style={[type.caption, { color: palette.accent }]}>
                {KIND_LABELS[kind] ?? kind}
              </Text>
            </View>
          ) : null}

          {fragment.pinned ? (
            <Text style={[type.caption, { color: palette.accent }]}>Pinned</Text>
          ) : null}

          <Text style={[type.caption, { color: palette.inkFaint }]}>
            {relativeTime(fragment.createdAt)} · {countWords(fragment.text)}w
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.md,
    gap: spacing.sm,
  },
  text: { fontSize: 16, lineHeight: 25 },
  meta: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  chip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
});
