import { asFragmentId } from "@loom/core";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useDatabase } from "@/db/provider";
import { useFragment } from "@/db/hooks";
import { countWords, relativeTime } from "@/lib/format";
import { fonts, radius, spacing, type, usePalette } from "@/theme";

/**
 * One note, editable.
 *
 * Editing is saved explicitly rather than on every keystroke. An autosave that
 * fires mid-thought would churn the enrichment queue — every text change clears
 * the fragment's digest and embedding — and re-index the same note a dozen times
 * while the user is still deciding on a word.
 */
export default function FragmentScreen() {
  const palette = usePalette();
  const router = useRouter();
  const { db, touch } = useDatabase();
  const params = useLocalSearchParams<{ id: string }>();
  const id = params.id === undefined ? null : asFragmentId(params.id);

  const fragment = useFragment(id);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (fragment.data !== null && !dirty) setText(fragment.data.text);
  }, [fragment.data, dirty]);

  if (fragment.loading) {
    return (
      <View style={[styles.centre, { backgroundColor: palette.bg }]}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  if (fragment.data === null || id === null) {
    return (
      <View style={[styles.centre, { backgroundColor: palette.bg }]}>
        <Text style={[type.body, { color: palette.inkSoft }]}>This note no longer exists.</Text>
      </View>
    );
  }

  const record = fragment.data;

  const save = async (): Promise<void> => {
    if (!dirty || text.trim().length === 0) return;
    setSaving(true);
    try {
      await db.updateText(id, text.trim());
      touch();
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (): void => {
    Alert.alert(
      "Delete this note?",
      "It will be removed from your notebook and from any book that used it. You can restore it later from Settings.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void (async () => {
              await db.softDelete(id);
              touch();
              router.back();
            })();
          },
        },
      ],
    );
  };

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: palette.bg }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <TextInput
          style={[
            styles.input,
            { color: palette.ink, backgroundColor: palette.surface, borderColor: palette.border, fontFamily: fonts.prose },
          ]}
          value={text}
          onChangeText={(next) => {
            setText(next);
            setDirty(true);
          }}
          multiline
          textAlignVertical="top"
          accessibilityLabel="Edit note"
        />

        <View style={styles.meta}>
          <Text style={[type.caption, { color: palette.inkFaint }]}>
            Written {relativeTime(record.createdAt)} · {countWords(text)} words
          </Text>
          {record.enrichment !== null ? (
            <Text style={[type.caption, { color: palette.inkFaint }]}>
              Read as: {record.enrichment.kind}
              {record.enrichment.themes.length > 0
                ? ` · ${record.enrichment.themes.join(", ")}`
                : ""}
            </Text>
          ) : (
            <Text style={[type.caption, { color: palette.inkFaint }]}>Not yet indexed</Text>
          )}
        </View>

        <View style={styles.actions}>
          <Pressable
            onPress={() => void save()}
            disabled={!dirty || saving}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.button,
              {
                backgroundColor: dirty ? palette.accent : palette.surfaceRaised,
                opacity: pressed && dirty ? 0.85 : 1,
              },
            ]}
          >
            {saving ? (
              <ActivityIndicator size="small" color={palette.surface} />
            ) : (
              <Text style={[type.label, { color: dirty ? palette.surface : palette.inkFaint }]}>
                {dirty ? "Save changes" : "Saved"}
              </Text>
            )}
          </Pressable>

          <Pressable
            onPress={() => {
              void db.setPinned(id, !record.pinned).then(touch);
            }}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: palette.surfaceRaised, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Text style={[type.label, { color: palette.ink }]}>
              {record.pinned ? "Unpin" : "Pin"}
            </Text>
          </Pressable>
        </View>

        <Pressable onPress={confirmDelete} accessibilityRole="button" style={styles.delete}>
          <Text style={[type.label, { color: palette.danger }]}>Delete note</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  centre: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xxl },
  input: {
    minHeight: 220,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    fontSize: 17,
    lineHeight: 28,
  },
  meta: { gap: spacing.xs, paddingHorizontal: spacing.xs },
  actions: { flexDirection: "row", gap: spacing.sm },
  button: {
    flex: 1,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
  },
  delete: { alignItems: "center", paddingVertical: spacing.md, minHeight: 44 },
});
