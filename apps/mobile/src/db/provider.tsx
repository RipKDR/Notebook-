import { LoomDatabase, ExpoSqliteAdapter, type ExpoSQLiteDatabase } from "@loom/db";
import * as SQLite from "expo-sqlite";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { spacing, type, usePalette } from "@/theme";

/**
 * Database lifecycle.
 *
 * Everything below this boundary is local and synchronous-feeling. Nothing in
 * the app awaits the network to show the user their own writing, which is the
 * property the whole product rests on.
 *
 * Migration failure is rendered rather than thrown. If the schema cannot be
 * brought up to date, the user's fragments are still on disk, and the worst
 * possible response is a white screen that makes them think the writing is gone.
 */

interface DatabaseContextValue {
  readonly db: LoomDatabase;
  /** Bumped after any write, so screens can refetch without a global store. */
  readonly revision: number;
  readonly touch: () => void;
}

const DatabaseContext = createContext<DatabaseContextValue | null>(null);

export const DATABASE_NAME = "loom.db";

type State =
  | { phase: "opening" }
  | { phase: "ready"; db: LoomDatabase }
  | { phase: "failed"; error: string };

export function DatabaseProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<State>({ phase: "opening" });
  const [revision, setRevision] = useState(0);
  const palette = usePalette();

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const raw = await SQLite.openDatabaseAsync(DATABASE_NAME);
        const database = new LoomDatabase(
          new ExpoSqliteAdapter(raw as unknown as ExpoSQLiteDatabase),
        );
        await database.migrate();
        if (!cancelled) setState({ phase: "ready", db: database });
      } catch (err: unknown) {
        if (!cancelled) {
          setState({
            phase: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<DatabaseContextValue | null>(
    () =>
      state.phase === "ready"
        ? { db: state.db, revision, touch: () => setRevision((n) => n + 1) }
        : null,
    [state, revision],
  );

  if (state.phase === "opening") {
    return (
      <View style={[styles.centre, { backgroundColor: palette.bg }]}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }

  if (state.phase === "failed") {
    return (
      <View style={[styles.centre, { backgroundColor: palette.bg }]}>
        <Text style={[type.title, styles.text, { color: palette.ink }]}>
          Could not open your notebook
        </Text>
        <Text style={[type.body, styles.text, { color: palette.inkSoft }]}>
          Your writing is still saved on this device. Reopening the app usually fixes this. If it
          keeps happening, please get in touch before reinstalling — reinstalling deletes local
          notes that have not synced.
        </Text>
        <Text style={[type.caption, styles.text, { color: palette.inkFaint }]}>{state.error}</Text>
      </View>
    );
  }

  return <DatabaseContext.Provider value={value}>{children}</DatabaseContext.Provider>;
}

export function useDatabase(): DatabaseContextValue {
  const ctx = useContext(DatabaseContext);
  if (ctx === null) {
    throw new Error("useDatabase must be used inside a DatabaseProvider");
  }
  return ctx;
}

const styles = StyleSheet.create({
  centre: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.md,
  },
  text: { textAlign: "center" },
});
