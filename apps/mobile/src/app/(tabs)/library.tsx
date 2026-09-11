import { getForm, type Project } from "@loom/core";
import { useRouter } from "expo-router";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState } from "@/components/EmptyState";
import { useCounts, useProjects } from "@/db/hooks";
import { formatWords, relativeTime } from "@/lib/format";
import { radius, spacing, type, usePalette } from "@/theme";

/** The books in progress. Usually one; occasionally several. */
export default function LibraryScreen() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const projects = useProjects();
  const counts = useCounts();

  return (
    <View style={[styles.root, { backgroundColor: palette.bg, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={[type.display, { color: palette.ink }]}>Library</Text>
          <View style={styles.headerActions}>
            <Pressable
              onPress={() => router.push("/settings")}
              accessibilityRole="button"
              accessibilityLabel="Settings"
              style={({ pressed }) => [
                styles.iconButton,
                { backgroundColor: palette.surfaceRaised, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <Text style={{ fontSize: 18, color: palette.inkSoft }}>⚙</Text>
            </Pressable>
            <Pressable
              onPress={() => router.push("/project/new")}
              accessibilityRole="button"
              accessibilityLabel="Start a new book"
              style={({ pressed }) => [
                styles.newButton,
                { backgroundColor: palette.accent, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <Text style={[type.label, { color: palette.surface }]}>New</Text>
            </Pressable>
          </View>
        </View>
        <Text style={[type.caption, { color: palette.inkFaint }]}>
          {projects.data.length === 0
            ? "Nothing started yet"
            : `${projects.data.length} in progress · drawing on ${formatWords(counts.data.words)}`}
        </Text>
      </View>

      <FlatList
        data={projects.data}
        keyExtractor={(p) => p.id}
        contentContainerStyle={[
          styles.list,
          projects.data.length === 0 ? styles.listEmpty : null,
        ]}
        renderItem={({ item }) => (
          <ProjectCard project={item} onPress={() => router.push(`/project/${item.id}`)} />
        )}
        ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
        ListEmptyComponent={
          projects.loading ? null : (
            <EmptyState
              glyph="▤"
              title="No books yet"
              body="Start one from a thread, or begin an empty book and let it fill up as you write. Nothing is committed — a book can be recompiled from your notes at any time."
            />
          )
        }
      />
    </View>
  );
}

function ProjectCard({ project, onPress }: { project: Project; onPress: () => void }) {
  const palette = usePalette();
  const form = getForm(project.form);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${project.title}`}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: palette.surface, borderColor: palette.border, opacity: pressed ? 0.8 : 1 },
      ]}
    >
      <View style={styles.cardHead}>
        <Text style={[type.title, styles.cardTitle, { color: palette.ink }]} numberOfLines={2}>
          {project.title}
        </Text>
        <View style={[styles.chip, { backgroundColor: palette.accentSoft }]}>
          <Text style={[type.caption, { color: palette.accent }]}>{form.label}</Text>
        </View>
      </View>

      <Text style={[type.body, { color: palette.inkSoft }]}>
        Target {project.targetWords.toLocaleString()} words
      </Text>
      <Text style={[type.caption, { color: palette.inkFaint }]}>
        Updated {relativeTime(project.updatedAt)}
      </Text>
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
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  iconButton: {
    minHeight: 44,
    minWidth: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
  },
  newButton: {
    minHeight: 44,
    minWidth: 64,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
  },
  list: { paddingHorizontal: spacing.md, paddingBottom: spacing.xxl },
  listEmpty: { flexGrow: 1 },
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.lg, gap: spacing.xs },
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  cardTitle: { flex: 1 },
  chip: { paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.pill },
});
