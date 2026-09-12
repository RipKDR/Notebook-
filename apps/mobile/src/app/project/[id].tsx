import { asProjectId, getForm, type DraftedScene, type Project } from "@loom/core";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
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
import { useCompile, type CompileStatus } from "@/lib/use-compile";
import {
  EXPORT_FORMATS,
  FORMAT_LABELS,
  NothingToExportError,
  shareProject,
  type ExportFormat,
} from "@/lib/export";
import { isConfigured, useSettings } from "@/lib/settings";
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

  const router = useRouter();
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

  const { status, start, cancel, reset } = useCompile(project);

  // A finished compile has written new scenes to SQLite; pull them in.
  useEffect(() => {
    if (status.phase === "done") void loadScenes();
  }, [status.phase, loadScenes]);

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

          <CompileRunner
            status={status}
            onStart={() => void start()}
            onCancel={() => void cancel()}
            onDismiss={reset}
            onOpenSettings={() => router.push("/settings")}
            enoughMaterial={fragments.data.length >= 20}
            written={written}
            noteCount={fragments.data.length}
          />

          {written ? <ExportPanel project={project} /> : null}
        </ScrollView>
      ) : (
        <Reader scenes={scenes} loading={loadingScenes} />
      )}
    </View>
  );
}

/**
 * The compile control.
 *
 * It is a small state machine rather than a button because a compile is a long,
 * failable, cancellable job, and every one of those states needs somewhere to be
 * shown. Hiding failure behind a spinner that eventually stops is how a user
 * concludes the app is broken and stops trusting it with their writing.
 */
function CompileRunner({
  status,
  onStart,
  onCancel,
  onDismiss,
  onOpenSettings,
  enoughMaterial,
  written,
  noteCount,
}: {
  status: CompileStatus;
  onStart: () => void;
  onCancel: () => void;
  onDismiss: () => void;
  onOpenSettings: () => void;
  enoughMaterial: boolean;
  written: boolean;
  noteCount: number;
}) {
  const palette = usePalette();
  const { settings } = useSettings();

  if (status.phase === "running" || status.phase === "starting" || status.phase === "saving") {
    const progress = status.phase === "running" ? status.progress : null;
    const fraction = progress?.fraction ?? 0;

    return (
      <View style={[styles.panel, { backgroundColor: palette.surface, borderColor: palette.accent }]}>
        <Text style={[type.heading, { color: palette.ink }]}>
          {status.phase === "saving" ? "Saving your book" : "Writing"}
        </Text>
        <Text style={[type.body, { color: palette.inkSoft }]}>
          {progress?.detail ?? "Getting started"}
        </Text>

        <View style={[styles.progressTrack, { backgroundColor: palette.surfaceRaised }]}>
          <View
            style={[
              styles.progressFill,
              { backgroundColor: palette.accent, width: `${Math.round(fraction * 100)}%` },
            ]}
          />
        </View>

        <Text style={[type.caption, { color: palette.inkFaint }]}>
          {Math.round(fraction * 100)}%
          {progress !== null && progress.spentUsd > 0
            ? ` · ${formatCost(progress.spentUsd)} so far`
            : ""}
          {" · you can close the app"}
        </Text>

        {status.phase === "running" ? (
          <Pressable onPress={onCancel} accessibilityRole="button" style={styles.subtleAction}>
            <Text style={[type.label, { color: palette.danger }]}>Stop</Text>
          </Pressable>
        ) : (
          <ActivityIndicator color={palette.accent} style={{ marginTop: spacing.sm }} />
        )}
      </View>
    );
  }

  if (status.phase === "done") {
    return (
      <View style={[styles.panel, { backgroundColor: palette.surface, borderColor: palette.success }]}>
        <Text style={[type.heading, { color: palette.ink }]}>Your book is written</Text>
        <Text style={[type.body, { color: palette.inkSoft }]}>
          {formatWords(status.words)} · {Math.round(status.coverage * 100)}% of your notes used
          {status.unused > 0
            ? ` · ${status.unused} ${pluralise(status.unused, "note")} did not fit`
            : ""}
        </Text>
        <Text style={[type.caption, { color: palette.inkFaint }]}>
          Cost {formatCost(status.costUsd)}. Open the Read tab.
        </Text>
        <Pressable onPress={onDismiss} accessibilityRole="button" style={styles.subtleAction}>
          <Text style={[type.label, { color: palette.accent }]}>Done</Text>
        </Pressable>
      </View>
    );
  }

  if (status.phase === "failed") {
    return (
      <View style={[styles.panel, { backgroundColor: palette.surface, borderColor: palette.danger }]}>
        <Text style={[type.heading, { color: palette.ink }]}>That did not work</Text>
        <Text style={[type.body, { color: palette.inkSoft }]}>{status.error}</Text>
        <Text style={[type.caption, { color: palette.inkFaint }]}>
          Your notes are untouched. Nothing was lost.
        </Text>
        <View style={styles.actionRow}>
          <Pressable onPress={onStart} accessibilityRole="button" style={styles.subtleAction}>
            <Text style={[type.label, { color: palette.accent }]}>Try again</Text>
          </Pressable>
          <Pressable onPress={onOpenSettings} accessibilityRole="button" style={styles.subtleAction}>
            <Text style={[type.label, { color: palette.inkSoft }]}>Settings</Text>
          </Pressable>
        </View>
      </View>
    );
  }

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

  if (!isConfigured(settings)) {
    return (
      <Pressable
        onPress={onOpenSettings}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.cta,
          { backgroundColor: palette.surfaceRaised, opacity: pressed ? 0.85 : 1 },
        ]}
      >
        <Text style={[type.heading, { color: palette.ink }]}>Connect a compile service</Text>
        <Text style={[type.caption, { color: palette.inkSoft }]}>
          Writing a book runs on a server. Set it up once in Settings.
        </Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onStart}
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
          : "This takes a while. You can close the app."}
      </Text>
    </Pressable>
  );
}

/**
 * Taking the book somewhere else.
 *
 * This runs on the device, against the copy already in local SQLite, so it works
 * with the network off — the same promise the app makes about the notes the book
 * came from. A book you cannot get out of the app is not really yours.
 */
function ExportPanel({ project }: { project: Project }) {
  const palette = usePalette();
  const { db } = useDatabase();
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (format: ExportFormat) => {
      setBusy(format);
      setError(null);
      try {
        await shareProject(db, project, format);
      } catch (err: unknown) {
        setError(
          err instanceof NothingToExportError
            ? err.message
            : err instanceof Error
              ? err.message
              : "The export failed.",
        );
      } finally {
        setBusy(null);
      }
    },
    [db, project],
  );

  return (
    <View style={[styles.panel, { backgroundColor: palette.surface, borderColor: palette.border }]}>
      <Text style={[type.label, { color: palette.inkFaint }]}>TAKE IT WITH YOU</Text>
      <Text style={[type.body, { color: palette.inkSoft }]}>
        Your book, as a file you own. This works offline.
      </Text>

      <View style={styles.exportRow}>
        {EXPORT_FORMATS.map((format) => (
          <Pressable
            key={format}
            onPress={() => void run(format)}
            disabled={busy !== null}
            accessibilityRole="button"
            accessibilityLabel={FORMAT_LABELS[format]}
            accessibilityState={{ disabled: busy !== null, busy: busy === format }}
            style={({ pressed }) => [
              styles.exportButton,
              {
                backgroundColor: palette.surfaceRaised,
                borderColor: palette.border,
                opacity: busy !== null && busy !== format ? 0.4 : pressed ? 0.85 : 1,
              },
            ]}
          >
            {busy === format ? (
              <ActivityIndicator color={palette.accent} />
            ) : (
              <Text style={[type.label, { color: palette.ink }]}>{format.toUpperCase()}</Text>
            )}
          </Pressable>
        ))}
      </View>

      {error !== null ? (
        <Text style={[type.caption, { color: palette.danger }]}>{error}</Text>
      ) : (
        <Text style={[type.caption, { color: palette.inkFaint }]}>
          EPUB to read · Word to edit · Markdown for anything else
        </Text>
      )}
    </View>
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
  subtleAction: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  exportRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  exportButton: {
    flex: 1,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    borderWidth: 1,
  },
  actionRow: { flexDirection: "row", gap: spacing.lg, justifyContent: "center" },
  reader: { paddingHorizontal: spacing.lg, paddingVertical: spacing.xl, paddingBottom: spacing.xxl },
  scene: { gap: spacing.md },
  sceneBreak: { textAlign: "center", paddingVertical: spacing.lg, letterSpacing: 4 },
  prose: { fontSize: 18, lineHeight: 30 },
  readerFoot: { textAlign: "center", paddingTop: spacing.xxl },
});
