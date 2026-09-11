import { clusterFragments, type Constellation } from "@loom/core";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState } from "@/components/EmptyState";
import { useFragments } from "@/db/hooks";
import { isConfigured, useSettings } from "@/lib/settings";
import { formatWords, lengthDescriptor, pluralise } from "@/lib/format";
import { radius, spacing, type, usePalette } from "@/theme";

/**
 * Threads — the constellation screen.
 *
 * This is the product's first magic moment. The user has been dropping sentences
 * into a box for months with no sense of shape, and this is the screen that
 * says: these fifty-three notes are about your father, and together they are
 * most of a novella.
 *
 * Everything here is computed on-device from embeddings already stored locally,
 * so it works offline and costs nothing to look at. The paid tier improves the
 * *quality* of the grouping by using real semantic embeddings; the free tier
 * still gets a genuine answer rather than a locked door.
 */
export default function ThreadsScreen() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const fragments = useFragments({ limit: 5000 });
  const { settings } = useSettings();
  const [clusters, setClusters] = useState<Constellation[] | null>(null);
  const [loose, setLoose] = useState<number>(0);

  const embedded = useMemo(
    () => fragments.data.filter((f) => f.embedding !== null).length,
    [fragments.data],
  );

  useEffect(() => {
    if (fragments.loading) return;
    if (fragments.data.length === 0) {
      setClusters([]);
      setLoose(0);
      return;
    }

    // Clustering a few thousand fragments is milliseconds of arithmetic, but it
    // is synchronous, so defer a frame to let the list paint first.
    const handle = setTimeout(() => {
      const result = clusterFragments(fragments.data);
      setClusters([...result.constellations]);
      setLoose(result.loose.length);
    }, 0);

    return () => clearTimeout(handle);
  }, [fragments.data, fragments.loading]);

  const indexing = embedded < fragments.data.length;

  return (
    <View style={[styles.root, { backgroundColor: palette.bg, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={[type.display, { color: palette.ink }]}>Threads</Text>
        <Text style={[type.caption, { color: palette.inkFaint }]}>
          {clusters === null
            ? "Looking for patterns"
            : clusters.length === 0
              ? "No threads yet"
              : `${clusters.length} ${pluralise(clusters.length, "thread")} found` +
                (loose > 0 ? ` · ${loose} loose ${pluralise(loose, "note")}` : "")}
        </Text>
      </View>

      {fragments.data.length > 0 && embedded === 0 && !isConfigured(settings) ? (
        <View style={[styles.notice, { backgroundColor: palette.surfaceRaised }]}>
          <Text style={[type.caption, styles.noticeText, { color: palette.inkSoft }]}>
            Threads need your notes read first, which runs on a compile service. Connect one in
            Settings and they will appear.
          </Text>
        </View>
      ) : null}

      {indexing && embedded > 0 && fragments.data.length > 0 ? (
        <View style={[styles.notice, { backgroundColor: palette.accentSoft }]}>
          <ActivityIndicator size="small" color={palette.accent} />
          <Text style={[type.caption, styles.noticeText, { color: palette.accent }]}>
            Still reading {(fragments.data.length - embedded).toLocaleString()} newer{" "}
            {pluralise(fragments.data.length - embedded, "note")}. Threads will sharpen as it
            catches up.
          </Text>
        </View>
      ) : null}

      <FlatList
        data={clusters ?? []}
        keyExtractor={(c) => c.id}
        contentContainerStyle={[
          styles.list,
          (clusters ?? []).length === 0 ? styles.listEmpty : null,
        ]}
        renderItem={({ item }) => (
          <ThreadCard
            constellation={item}
            onPress={() =>
              router.push({
                pathname: "/project/new",
                params: { fragmentIds: item.fragmentIds.join(","), threadId: item.id },
              })
            }
          />
        )}
        ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
        ListEmptyComponent={
          clusters === null ? (
            <View style={styles.loading}>
              <ActivityIndicator color={palette.accent} />
            </View>
          ) : (
            <EmptyState
              glyph="✵"
              title="Not enough to go on yet"
              body="Threads appear once you have written enough for patterns to show — usually somewhere around thirty notes. Keep writing without worrying about what it is for."
            />
          )
        }
      />
    </View>
  );
}

function ThreadCard({
  constellation,
  onPress,
}: {
  constellation: Constellation;
  onPress: () => void;
}) {
  const palette = usePalette();

  const title =
    constellation.dominantThemes[0] ??
    constellation.dominantEntities[0]?.split(":")[1]?.replace(/-/g, " ") ??
    "An unnamed thread";

  const subjects = constellation.dominantEntities
    .slice(0, 4)
    .map((e) => e.split(":")[1]?.replace(/-/g, " ") ?? e);

  // Cohesion is a real number the user should not have to interpret.
  const strength =
    constellation.cohesion > 0.6 ? "Strong" : constellation.cohesion > 0.42 ? "Clear" : "Loose";

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${constellation.fragmentIds.length} notes`}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: palette.surface, borderColor: palette.border, opacity: pressed ? 0.8 : 1 },
      ]}
    >
      <View style={styles.cardHead}>
        <Text style={[type.title, styles.cardTitle, { color: palette.ink }]} numberOfLines={2}>
          {title}
        </Text>
        <View style={[styles.chip, { backgroundColor: palette.surfaceRaised }]}>
          <Text style={[type.caption, { color: palette.inkSoft }]}>{strength}</Text>
        </View>
      </View>

      <Text style={[type.body, { color: palette.inkSoft }]}>
        {constellation.fragmentIds.length.toLocaleString()}{" "}
        {pluralise(constellation.fragmentIds.length, "note")} ·{" "}
        {formatWords(constellation.wordCount)}
      </Text>

      <Text style={[type.caption, { color: palette.inkFaint }]}>
        {lengthDescriptor(constellation.wordCount)}
      </Text>

      {subjects.length > 0 ? (
        <View style={styles.chips}>
          {subjects.map((s) => (
            <View key={s} style={[styles.chip, { backgroundColor: palette.accentSoft }]}>
              <Text style={[type.caption, { color: palette.accent }]}>{s}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <Text style={[type.label, { color: palette.accent }]}>Make this a book →</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.xs,
  },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  noticeText: { flex: 1 },
  list: { paddingHorizontal: spacing.md, paddingBottom: spacing.xxl },
  listEmpty: { flexGrow: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: spacing.xxl },
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  cardTitle: { flex: 1, textTransform: "capitalize" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.xs },
  chip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
});
