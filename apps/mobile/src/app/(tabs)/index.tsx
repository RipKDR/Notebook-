import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCapture, useCounts, useFragments } from "@/db/hooks";
import { countWords, formatWords, lengthDescriptor, relativeTime } from "@/lib/format";
import { fonts, radius, spacing, type, usePalette } from "@/theme";

/**
 * Capture.
 *
 * This screen decides whether the product works. A user has a sentence in their
 * head while walking, queueing or half asleep; if getting it down takes more
 * than a couple of seconds they will not do it, and a notebook with no fragments
 * compiles into nothing.
 *
 * So: opens focused with the keyboard already up, no title field, no tags, no
 * project picker, no confirmation dialog. One box and one button. Everything
 * else in the app exists to make sense of what this screen collects, and none of
 * it is allowed to add a step here.
 *
 * Saving deliberately does not dismiss or navigate. Thoughts arrive in clusters,
 * and being thrown back to a list after each one is how you lose the next three.
 */
export default function CaptureScreen() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const capture = useCapture();

  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputRef = useRef<TextInput>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const recent = useFragments({ limit: 8 });
  const counts = useCounts();

  useEffect(
    () => () => {
      if (savedTimer.current !== null) clearTimeout(savedTimer.current);
    },
    [],
  );

  const words = countWords(text);
  const canSave = text.trim().length > 0 && !saving;

  const save = useCallback(async () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || saving) return;

    setSaving(true);
    setError(null);
    try {
      await capture(trimmed, "quick");

      // Clear immediately so the next thought has somewhere to go.
      setText("");
      setJustSaved(true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      AccessibilityInfo.announceForAccessibility?.("Note saved");

      if (savedTimer.current !== null) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setJustSaved(false), 1600);

      // Keep the keyboard up: the next sentence is usually already forming.
      inputRef.current?.focus();
    } catch (err: unknown) {
      // The text stays in the box. Losing someone's writing to a failed insert
      // is the one unforgivable bug in a notebook app.
      setError(
        err instanceof Error
          ? `Could not save: ${err.message}. Your text is still here.`
          : "Could not save. Your text is still here.",
      );
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setSaving(false);
    }
  }, [capture, saving, text]);

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: palette.bg, paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Text style={[type.display, { color: palette.ink }]}>What is it?</Text>
        <Text style={[type.caption, { color: palette.inkFaint }]}>
          {counts.data.total === 0
            ? "Anything. A line, a scrap, a half-thought."
            : `${counts.data.total.toLocaleString()} notes · ${lengthDescriptor(counts.data.words)}`}
        </Text>
      </View>

      <View
        style={[
          styles.composer,
          { backgroundColor: palette.surface, borderColor: error !== null ? palette.danger : palette.border },
        ]}
      >
        <TextInput
          ref={inputRef}
          style={[styles.input, { color: palette.ink, fontFamily: fonts.prose }]}
          value={text}
          onChangeText={(next) => {
            setText(next);
            if (error !== null) setError(null);
          }}
          placeholder="She never once said my name."
          placeholderTextColor={palette.inkFaint}
          multiline
          autoFocus
          autoCorrect
          autoCapitalize="sentences"
          textAlignVertical="top"
          scrollEnabled
          accessibilityLabel="Write a note"
        />

        <View style={[styles.composerFoot, { borderTopColor: palette.border }]}>
          <Text style={[type.caption, { color: palette.inkFaint }]}>
            {words === 0 ? "Nothing is too small" : formatWords(words)}
          </Text>

          <Pressable
            onPress={() => void save()}
            disabled={!canSave}
            accessibilityRole="button"
            accessibilityLabel="Save note"
            accessibilityState={{ disabled: !canSave }}
            style={({ pressed }) => [
              styles.saveButton,
              {
                backgroundColor: canSave ? palette.accent : palette.surfaceRaised,
                opacity: pressed && canSave ? 0.85 : 1,
              },
            ]}
          >
            {saving ? (
              <ActivityIndicator size="small" color={palette.surface} />
            ) : (
              <Text
                style={[
                  type.label,
                  { color: canSave ? palette.surface : palette.inkFaint },
                ]}
              >
                {justSaved ? "Saved ✓" : "Keep"}
              </Text>
            )}
          </Pressable>
        </View>
      </View>

      {error !== null ? (
        <Text style={[type.caption, styles.error, { color: palette.danger }]} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      <ScrollView
        style={styles.recent}
        contentContainerStyle={{ paddingBottom: spacing.xxl }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {recent.data.length > 0 ? (
          <Text style={[type.label, styles.recentHeading, { color: palette.inkFaint }]}>
            Lately
          </Text>
        ) : null}

        {recent.data.map((fragment) => (
          <View
            key={fragment.id}
            style={[styles.recentItem, { borderBottomColor: palette.border }]}
          >
            <Text
              numberOfLines={3}
              style={[type.body, { color: palette.inkSoft, fontFamily: fonts.prose }]}
            >
              {fragment.text}
            </Text>
            <Text style={[type.caption, { color: palette.inkFaint }]}>
              {relativeTime(fragment.createdAt)}
            </Text>
          </View>
        ))}
      </ScrollView>
    </KeyboardAvoidingView>
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
  composer: {
    marginHorizontal: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    overflow: "hidden",
  },
  input: {
    minHeight: 160,
    maxHeight: 300,
    padding: spacing.md,
    fontSize: 18,
    lineHeight: 28,
  },
  composerFoot: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
  },
  saveButton: {
    minWidth: 88,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
  },
  error: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  recent: { flex: 1, marginTop: spacing.lg },
  recentHeading: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  recentItem: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    gap: spacing.xs,
  },
});
