import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { DatabaseProvider } from "@/db/provider";
import { darkPalette, lightPalette } from "@/theme";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const scheme = useColorScheme();
  const isDark = scheme === "dark";
  const palette = isDark ? darkPalette : lightPalette;

  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);

  const navigationTheme = {
    ...(isDark ? DarkTheme : DefaultTheme),
    colors: {
      ...(isDark ? DarkTheme : DefaultTheme).colors,
      background: palette.bg,
      card: palette.surface,
      text: palette.ink,
      border: palette.border,
      primary: palette.accent,
    },
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider value={navigationTheme}>
          <DatabaseProvider>
            <StatusBar style={isDark ? "light" : "dark"} />
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: palette.bg },
                headerTintColor: palette.ink,
                headerShadowVisible: false,
                contentStyle: { backgroundColor: palette.bg },
              }}
            >
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen
                name="fragment/[id]"
                options={{ title: "Note", presentation: "card" }}
              />
              <Stack.Screen name="project/[id]" options={{ title: "" }} />
              <Stack.Screen
                name="project/new"
                options={{ title: "New book", presentation: "modal" }}
              />
            </Stack>
          </DatabaseProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
