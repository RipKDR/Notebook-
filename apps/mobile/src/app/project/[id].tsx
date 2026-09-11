import { asProjectId, getForm, type DraftedScene, type Project } from "@loom/core";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useDatabase } from "@/db/provider";
import { useFragments, useProjects } from "@/db/hooks";
import { formatCost, formatWords, pluralise, readingTime } from "@/lib/format";
import { fonts, radius, spacing, type, usePalette } from "@/theme";

/**
 * A book: its current state, the compile control, and the reader.
 *
 * The screen is honest about three things most tools of this kind hide, because
 * each one is load-bearing for trust:
 *
 *   - what a compile will cost, before it runs;
 *   - how much of the user's own writing actually made it in;
 *   - which of their notes did not, and why.
 *
 * A user who has been feeding a notebook for months deserves to know the answer
 * to the third one. Silently dropping a third of someone's writing and
 * presenting the result as their book is the fastest way to lose them.
 */
export default function ProjectScreen() {
  const palette = usePalette();
  const navigation = useNavigation();
  const { db } = useDatabase();
  const params = useLocalSearchParams<{ id: string }>();
  const projectId = params.id === undefined ? null : asProjectId(params.id);

  const projects = useProjects();
  const project = useMemo<Project | null>(
    () => projects.data.find((p) => p.id === projectId) ?? null,
    [projects.data, projectId],
  );

  const fragments = useFragments({ projectId: projectId ?? undefined, limit: 5000 });
  const [scenes, setScenes] = useState<DraftedScene[]>([]);
  const [loadingScenes, setLoadingScenes] = useState(true);
  const [tab, setTab] = useState<"status" | "read">("status");

  const loadScenes = useCallback(async () => {
    if (projectId === null) return;
    setLoadingScenes(true);
    try {
      setScenes(await db.loadScenes(projectId));
    } finally {
      setLoadingScenes(false);
    }
  }, [db, projectId]);

  useEffect(() => {
    void loadScenes();
  }, [loadScenes]);

  useEffect(() => {
    if (project !== null) navigation.setOptions({ title: project.title });
  }, [navigation, project]);

  if (project === null || projectId === null) {
    return (
      <View style={[styles.centre, { backgroundColor: palette.bg }]}>
        {projects.loading ? (
          <ActivityIndicator color={palette.accent} />
        ) : (
          <Text style={[type.body, { color: palette.inkSoft }]}>This book no longer exists.</Text>
        )}
      </View>
    );
  }

  const words = scenes.reduce((n, s) => n + s.wordCount, 0);
  const spent = scenes.reduce((n, s) => n + s.costUsd, 0);
  const written = scenes.length > 0;

  return (
    <View style={[styles.root, { backgroundColor: palette.bg }]}>
      <View style={[styles.tabs, { borderBottomColor: palette.border }]}>
        {(["status", "read"] as const).map((key) => {
          const active = tab === key;
          const disabled = key === "read" && !written;
          return (
            <Pressable
              key={key}
              onPress={() => !disabled && setTab(key)}
              disabled={disabled}
              accessibilityRole="tab"
              accessibilityState={{ selected: active, disabled }}
              style={[styles.tab, active ? { borderBottomColor: palette.accent } : null]}
            >
              <Text
                style={[
                  type.label,
                  {
                    color: disabled
                      ? palette.inkFaint
                      : active
                        ? palette.accent
                        : palette.inkSoft,
                  },
                ]}
              >
                {key === "status" ? "The book" : "Read"}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {tab === "status" ? (
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={[styles.panel, { backgroundColor: palette.surface, borderColor: palette.border }]}>
            <Text style={[type.label, { color: palette.inkFaint }]}>SOURCE MATERIAL</Text>
            <Text style={[type.display, { color: palette.ink }]}>
              {fragments.data.length.toLocaleString()}
            </Text>
            <Text style={[type.body, { color: palette.inkSoft }]}>
              {pluralise(fragments.data.length, "note")} assigned to this book
            </Text>
            <Text style={[type.caption, { color: palette.inkFaint }]}>
              Target {project.targetWords.toLocaleString()} words · {getForm(project.form).label}
            </Text>
          </View>

          {written ? (
            <View style={[styles.panel, { backgroundColor: palette.surface, borderColor: palette.border }]}>
              <Text style={[type.label, { color: palette.inkFaint }]}>WRITTEN SO FAR</Text>
              <Text style={[type.display, { color: palette.ink }]}>{words.toLocaleString()}</Text>
              <Text style={[type.body, { color: palette.inkSoft }]}>
                words across {scenes.length} {pluralise(scenes.length, "scene")} ·{" "}
                {readingTime(words)}
              </Text>
              <View style={[styles.progressTrack, { backgroundColor: palette.surfaceRaised }]}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      backgroundColor: palette.accent,
                      width: `${Math.min(100, (words / project.targetWords) * 100)}%`,
                    },
                  ]}
                />
              </View>
              <Text style={[type.caption, { color: palette.inkFaint }]}>
                {Math.round((words / project.targetWords) * 100)}% of target · cost so far{" "}
                {formatCost(spent)}
              </Text>
            </View>
          ) : (
            <View style={[styles.panel, { backgroundColor: palette.surface, borderColor: palette.border }]}>
              <Text style={[type.heading, { color: palette.ink }]}>Not written yet</Text>
              <Text style={[type.body, { color: palette.inkSoft }]}>
                When you compile, your notes are read as a whole, given a structure, and written out
                as a full-length {getForm(project.form).label.toLowerCase()}. Nothing you have
                written is changed or deleted — the book is built from your notes, not instead of
                them.
              </Text>
              <Text style={[type.caption, { color: palette.inkFaint }]}>
                Recompiling later only rewrites the parts your new notes actually affect.
              </Text>
            </View>
          )}

          <CompileButton
            enoughMaterial={fragments.data.length >= 20}
            written={written}
            noteCount={fragments.data.length}
          />
        </ScrollView>
      ) : (
        <Reader scenes={scenes} loading={loadingScenes} />
      )}
    </View>
  );
}

function CompileButton({
  enoughMaterial,
  written,
  noteCount,
}: {
  enoughMaterial: boolean;
  written: boolean;
  noteCount: number;
}) {
  const palette = usePalette();

  if (!enoughMaterial) {
    return (
      <View style={[styles.panel, { backgroundColor: palette.surfaceRaised, borderColor: palette.border }]}>
        <Text style={[type.heading, { color: palette.ink }]}>Keep writing</Text>
        <Text style={[type.body, { color: palette.inkSoft }]}>
          {noteCount} {pluralise(noteCount, "note")} so far. A book needs something to be built
          from — around twenty notes is usually enough to find a shape, and more is better.
        </Text>
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.cta,
        { backgroundColor: palette.accent, opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <Text style={[type.heading, { color: palette.surface }]}>
        {written ? "Update the book" : "Write the book"}
      </Text>
      <Text style={[type.caption, { color: palette.surface }]}>
        {written
          ? "Only the parts your new notes touch will be rewritten"
          : "This takes a while. You will get a notification when it is done."}
      </Text>
    </Pressable>
  );
}

function Reader({ scenes, loading }: { scenes: readonly DraftedScene[]; loading: boolean }) {
  const palette = usePalette();

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.reader}>
      {scenes.map((scene, i) => (
        <View key={scene.sceneId} style={styles.scene}>
          {i > 0 ? (
            <Text style={[styles.sceneBreak, { color: palette.inkFaint }]}>* * *</Text>
          ) : null}
          <Text
            style={[styles.prose, { color: palette.ink, fontFamily: fonts.prose }]}
            selectable
          >
            {scene.prose}
          </Text>
        </View>
      ))}
      <Text style={[type.caption, styles.readerFoot, { color: palette.inkFaint }]}>
        {formatWords(scenes.reduce((n, s) => n + s.wordCount, 0))} · end of what has been written
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  centre: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  tabs: { flexDirection: "row", borderBottomWidth: 1 },
  tab: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacing.md,
    minHeight: 48,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  scroll: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xxl },
  panel: { padding: spacing.lg, borderRadius: radius.lg, borderWidth: 1, gap: spacing.xs },
  progressTrack: { height: 6, borderRadius: radius.pill, overflow: "hidden", marginTop: spacing.sm },
  progressFill: { height: "100%", borderRadius: radius.pill },
  cta: {
    minHeight: 68,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: 2,
  },
  reader: { paddingHorizontal: spacing.lg, paddingVertical: spacing.xl, paddingBottom: spacing.xxl },
  scene: { gap: spacing.md },
  sceneBreak: { textAlign: "center", paddingVertical: spacing.lg, letterSpacing: 4 },
  prose: { fontSize: 18, lineHeight: 30 },
  readerFoot: { textAlign: "center", paddingTop: spacing.xxl },
});
