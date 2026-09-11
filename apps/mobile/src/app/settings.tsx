import { useEffect, useState } from "react";
import {
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
import { useCounts } from "@/db/hooks";
import { useIndexer } from "@/lib/use-indexer";
import { isConfigured, tierFromToken, useSettings } from "@/lib/settings";
import { pluralise } from "@/lib/format";
import { radius, spacing, type, usePalette } from "@/theme";

/**
 * Connecting the app to a compile service.
 *
 * Writing a book needs a model, and the model needs a credential the phone must
 * never hold — so the work happens on a server and this is where a user points
 * at theirs. Everything else in the app works without it: capture, search,
 * editing and reading are entirely local, and always will be.
 */
export default function SettingsScreen() {
  const palette = usePalette();
  const { settings, loading, update } = useSettings();
  const counts = useCounts();
  const indexer = useIndexer();

  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setUrl(settings.baseUrl ?? "");
    setToken(settings.token ?? "");
  }, [settings.baseUrl, settings.token]);

  const tier = tierFromToken(settings.token);
  const unindexed = counts.data.total - counts.data.enriched;

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await update({ baseUrl: url.trim() || null, token: token.trim() || null });
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.centre, { backgroundColor: palette.bg }]}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: palette.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={[styles.panel, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <Text style={[type.heading, { color: palette.ink }]}>Your notebook</Text>
          <Text style={[type.body, { color: palette.inkSoft }]}>
            {counts.data.total.toLocaleString()} {pluralise(counts.data.total, "note")} ·{" "}
            {counts.data.words.toLocaleString()} words, all stored on this device.
          </Text>
          <Text style={[type.caption, { color: palette.inkFaint }]}>
            {unindexed > 0
              ? `${unindexed} ${pluralise(unindexed, "note")} still to be read for Threads.`
              : "Everything has been read."}
          </Text>

          {unindexed > 0 ? (
            <Pressable
              onPress={() => void indexer.run()}
              disabled={indexer.running}
              accessibilityRole="button"
              style={[styles.action, { backgroundColor: palette.surfaceRaised }]}
            >
              {indexer.running ? (
                <ActivityIndicator size="small" color={palette.accent} />
              ) : (
                <Text style={[type.label, { color: palette.ink }]}>Read them now</Text>
              )}
            </Pressable>
          ) : null}

          {indexer.lastResult?.error != null ? (
            <Text style={[type.caption, { color: palette.danger }]}>
              {indexer.lastResult.error}
            </Text>
          ) : null}
        </View>

        <View style={styles.field}>
          <Text style={[type.label, { color: palette.inkSoft }]}>COMPILE SERVICE</Text>
          <Text style={[type.caption, { color: palette.inkFaint }]}>
            Turning notes into a book runs on a server, because it needs a model credential that
            should never live on a phone. Capture, search and reading work without this.
          </Text>

          <TextInput
            style={[
              styles.input,
              { backgroundColor: palette.surface, borderColor: palette.border, color: palette.ink },
            ]}
            value={url}
            onChangeText={setUrl}
            placeholder="https://your-worker.example.com"
            placeholderTextColor={palette.inkFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel="Compile service address"
          />

          <TextInput
            style={[
              styles.input,
              { backgroundColor: palette.surface, borderColor: palette.border, color: palette.ink },
            ]}
            value={token}
            onChangeText={setToken}
            placeholder="Access token"
            placeholderTextColor={palette.inkFaint}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            accessibilityLabel="Access token"
          />

          <Text style={[type.caption, { color: palette.inkFaint }]}>
            Your token is kept in this device&apos;s keychain, never in plain storage.
          </Text>

          {tier !== null ? (
            <Text style={[type.caption, { color: palette.accent }]}>
              Signed in on the {tier} plan.
            </Text>
          ) : null}
        </View>

        <Pressable
          onPress={() => void save()}
          disabled={saving}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.cta,
            { backgroundColor: palette.accent, opacity: pressed || saving ? 0.85 : 1 },
          ]}
        >
          {saving ? (
            <ActivityIndicator color={palette.surface} />
          ) : (
            <Text style={[type.heading, { color: palette.surface }]}>
              {saved ? "Saved ✓" : "Save"}
            </Text>
          )}
        </Pressable>

        {isConfigured(settings) ? (
          <Pressable
            onPress={() => void update({ baseUrl: null, token: null })}
            accessibilityRole="button"
            style={styles.disconnect}
          >
            <Text style={[type.label, { color: palette.danger }]}>Disconnect</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: { padding: spacing.md, gap: spacing.lg, paddingBottom: spacing.xxl },
  panel: { padding: spacing.lg, borderRadius: radius.lg, borderWidth: 1, gap: spacing.xs },
  field: { gap: spacing.sm },
  input: {
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    fontSize: 16,
  },
  action: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    marginTop: spacing.sm,
  },
  cta: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
  },
  disconnect: { alignItems: "center", minHeight: 44, justifyContent: "center" },
});
