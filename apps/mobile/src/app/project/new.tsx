import { LENGTH_PRESETS, asFragmentId, listForms, type LengthPreset, type WorkForm } from "@loom/core";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useDatabase } from "@/db/provider";
import { radius, spacing, type, usePalette } from "@/theme";

/**
 * Starting a book.
 *
 * Three decisions, all reversible: what kind of thing it is, roughly how long,
 * and what it is called. The form choice matters most — it selects the Bible
 * schema and the whole structural template, and fiction and memoir are planned
 * on genuinely different principles.
 */
export default function NewProjectScreen() {
  const palette = usePalette();
  const router = useRouter();
  const { db, touch } = useDatabase();
  const params = useLocalSearchParams<{ fragmentIds?: string }>();

  const seeded = (params.fragmentIds ?? "").split(",").filter(Boolean);

  const [title, setTitle] = useState("");
  const [form, setForm] = useState<WorkForm>("memoir");
  const [preset, setPreset] = useState<LengthPreset>("novel");
  const [creating, setCreating] = useState(false);

  const create = async (): Promise<void> => {
    setCreating(true);
    try {
      const project = await db.createProject(
        title.trim() || "Untitled",
        form,
        LENGTH_PRESETS[preset],
      );
      if (seeded.length > 0) {
        await db.assignFragments(seeded.map(asFragmentId), project.id);
      }
      touch();
      router.replace(`/project/${project.id}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <ScrollView
      style={{ backgroundColor: palette.bg }}
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
    >
      {seeded.length > 0 ? (
        <View style={[styles.notice, { backgroundColor: palette.accentSoft }]}>
          <Text style={[type.body, { color: palette.accent }]}>
            Starting from {seeded.length} notes in this thread. Everything else you write can still
            be pulled in later.
          </Text>
        </View>
      ) : null}

      <View style={styles.field}>
        <Text style={[type.label, { color: palette.inkSoft }]}>WHAT IS IT?</Text>
        {listForms().map((definition) => {
          const selected = form === definition.form;
          return (
            <Pressable
              key={definition.form}
              onPress={() => setForm(definition.form)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              style={[
                styles.option,
                {
                  backgroundColor: selected ? palette.accentSoft : palette.surface,
                  borderColor: selected ? palette.accent : palette.border,
                },
              ]}
            >
              <Text style={[type.heading, { color: selected ? palette.accent : palette.ink }]}>
                {definition.label}
              </Text>
              <Text style={[type.caption, { color: palette.inkSoft }]}>
                {definition.description}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.field}>
        <Text style={[type.label, { color: palette.inkSoft }]}>HOW LONG?</Text>
        <View style={styles.row}>
          {(Object.keys(LENGTH_PRESETS) as LengthPreset[]).map((key) => {
            const selected = preset === key;
            return (
              <Pressable
                key={key}
                onPress={() => setPreset(key)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                style={[
                  styles.lengthOption,
                  {
                    backgroundColor: selected ? palette.accent : palette.surface,
                    borderColor: selected ? palette.accent : palette.border,
                  },
                ]}
              >
                <Text
                  style={[type.label, { color: selected ? palette.surface : palette.ink }]}
                >
                  {key[0]!.toUpperCase() + key.slice(1)}
                </Text>
                <Text
                  style={[
                    type.caption,
                    { color: selected ? palette.surface : palette.inkFaint },
                  ]}
                >
                  {(LENGTH_PRESETS[key] / 1000).toFixed(0)}k words
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.field}>
        <Text style={[type.label, { color: palette.inkSoft }]}>CALL IT SOMETHING</Text>
        <TextInput
          style={[
            styles.input,
            { backgroundColor: palette.surface, borderColor: palette.border, color: palette.ink },
          ]}
          value={title}
          onChangeText={setTitle}
          placeholder="You can change this later"
          placeholderTextColor={palette.inkFaint}
          accessibilityLabel="Book title"
          returnKeyType="done"
        />
      </View>

      <Pressable
        onPress={() => void create()}
        disabled={creating}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.cta,
          { backgroundColor: palette.accent, opacity: pressed || creating ? 0.85 : 1 },
        ]}
      >
        {creating ? (
          <ActivityIndicator color={palette.surface} />
        ) : (
          <Text style={[type.heading, { color: palette.surface }]}>Start the book</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.md, gap: spacing.lg, paddingBottom: spacing.xxl },
  notice: { padding: spacing.md, borderRadius: radius.md },
  field: { gap: spacing.sm },
  option: { padding: spacing.md, borderRadius: radius.md, borderWidth: 1, gap: spacing.xs },
  row: { flexDirection: "row", gap: spacing.sm },
  lengthOption: {
    flex: 1,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: "center",
    gap: 2,
    minHeight: 64,
    justifyContent: "center",
  },
  input: {
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    fontSize: 16,
  },
  cta: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    marginTop: spacing.sm,
  },
});
