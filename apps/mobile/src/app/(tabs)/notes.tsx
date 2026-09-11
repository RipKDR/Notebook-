import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import {
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState } from "@/components/EmptyState";
import { FragmentCard } from "@/components/FragmentCard";
import { useCounts, useFragments, useSearch } from "@/db/hooks";
import { formatWords, lengthDescriptor } from "@/lib/format";
import { radius, spacing, type, usePalette } from "@/theme";

/**
 * Everything the user has written, newest first, with full-text search.
 *
 * Search runs against the local FTS5 index, so results appear as fast as the
 * user can type with no network and no debounce ceremony.
 */
export default function NotesScreen() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [query, setQuery] = useState("");

  const all = useFragments({ limit: 500 });
  const found = useSearch(query);
  const counts = useCounts();

  const searching = query.trim().length > 0;
  const items = searching ? found.data : all.data;
  const loading = searching ? found.loading : all.loading;

  const subtitle = useMemo(() => {
    if (searching) {
      return `${items.length} ${items.length === 1 ? "match" : "matches"}`;
    }
    return `${counts.data.total.toLocaleString()} notes · ${formatWords(counts.data.words)}`;
  }, [searching, items.length, counts.data]);

  return (
    <View style={[styles.root, { backgroundColor: palette.bg, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={[type.display, { color: palette.ink }]}>Notes</Text>
        <Text style={[type.caption, { color: palette.inkFaint }]}>{subtitle}</Text>
      </View>

      <TextInput
        style={[
          styles.search,
          { backgroundColor: palette.surface, borderColor: palette.border, color: palette.ink },
        ]}
        value={query}
        onChangeText={setQuery}
        placeholder="Search your writing"
        placeholderTextColor={palette.inkFaint}
        autoCorrect={false}
        autoCapitalize="none"
        clearButtonMode="while-editing"
        returnKeyType="search"
        accessibilityLabel="Search notes"
      />

      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[
          styles.list,
          items.length === 0 ? styles.listEmpty : null,
        ]}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <FragmentCard
            fragment={item}
            onPress={() => router.push(`/fragment/${item.id}`)}
          />
        )}
        ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
        ListEmptyComponent={
          loading ? null : searching ? (
            <EmptyState
              glyph="⌕"
              title="Nothing matches"
              body="Try a different word. Search looks at every note you have written, including ones you have since forgotten about."
            />
          ) : (
            <EmptyState
              glyph="✎"
              title="Nothing yet"
              body={`Write a sentence on the Write tab. Anything at all — ${lengthDescriptor(0)} is where every book starts.`}
            />
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
    gap: spacing.xs,
  },
  search: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    minHeight: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    fontSize: 16,
  },
  list: { paddingHorizontal: spacing.md, paddingBottom: spacing.xxl },
  listEmpty: { flexGrow: 1 },
});
