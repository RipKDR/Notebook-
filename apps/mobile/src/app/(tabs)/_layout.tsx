import { Tabs } from "expo-router";
import { Text, type ColorValue } from "react-native";
import { usePalette } from "@/theme";

/**
 * Four tabs, in the order the product is actually used:
 * capture first, because that is what happens forty times a week; the book last,
 * because that is what happens twice.
 *
 * Glyphs rather than an icon package — these four read clearly at tab size and
 * avoid a dependency for eight characters.
 */
const GLYPHS = {
  capture: "✎",
  notes: "☰",
  threads: "✵",
  library: "▤",
} as const;

function TabGlyph({ glyph, color }: { glyph: string; color: ColorValue }) {
  return <Text style={{ fontSize: 20, color, lineHeight: 24 }}>{glyph}</Text>;
}

export default function TabsLayout() {
  const palette = usePalette();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.accent,
        tabBarInactiveTintColor: palette.inkFaint,
        tabBarStyle: {
          backgroundColor: palette.surface,
          borderTopColor: palette.border,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
        sceneStyle: { backgroundColor: palette.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Write",
          tabBarIcon: ({ color }) => <TabGlyph glyph={GLYPHS.capture} color={color} />,
        }}
      />
      <Tabs.Screen
        name="notes"
        options={{
          title: "Notes",
          tabBarIcon: ({ color }) => <TabGlyph glyph={GLYPHS.notes} color={color} />,
        }}
      />
      <Tabs.Screen
        name="threads"
        options={{
          title: "Threads",
          tabBarIcon: ({ color }) => <TabGlyph glyph={GLYPHS.threads} color={color} />,
        }}
      />
      <Tabs.Screen
        name="library"
        options={{
          title: "Library",
          tabBarIcon: ({ color }) => <TabGlyph glyph={GLYPHS.library} color={color} />,
        }}
      />
    </Tabs>
  );
}
