import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { spacing, type, usePalette } from "@/theme";

/**
 * Empty states carry real weight in this app. A new user's notebook is empty for
 * weeks before it becomes a book, and a screen that just says "No data" during
 * that period teaches them the app is not working. Each of these says what to do
 * next, and what it will eventually become.
 */
export function EmptyState({
  glyph,
  title,
  body,
  action,
}: {
  glyph: string;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  const palette = usePalette();
  return (
    <View style={styles.root}>
      <Text style={[styles.glyph, { color: palette.inkFaint }]}>{glyph}</Text>
      <Text style={[type.title, styles.centre, { color: palette.ink }]}>{title}</Text>
      <Text style={[type.body, styles.centre, { color: palette.inkSoft }]}>{body}</Text>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.md,
  },
  glyph: { fontSize: 40 },
  centre: { textAlign: "center", maxWidth: 320 },
});
