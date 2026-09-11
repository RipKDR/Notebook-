import { Platform, StyleSheet, useColorScheme, type TextStyle } from "react-native";

/**
 * The design language.
 *
 * This is a writing tool, so the visual language borrows from paper rather than
 * from software: warm off-white, ink-black text, a serif for the user's own
 * words and a system sans for everything the app says. The distinction is
 * load-bearing — a user should be able to tell their sentences from ours at a
 * glance, especially once the compiler starts producing prose of its own.
 *
 * Plain StyleSheet rather than a utility-CSS layer: NativeWind has not cut a
 * release since before this React Native version shipped and has an open
 * regression against it, which is not a dependency to put under the one screen
 * that must never fail.
 */

export interface Palette {
  readonly bg: string;
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly border: string;
  readonly ink: string;
  readonly inkSoft: string;
  readonly inkFaint: string;
  readonly accent: string;
  readonly accentSoft: string;
  readonly danger: string;
  readonly success: string;
  readonly overlay: string;
}

const light: Palette = {
  bg: "#FBF9F4",
  surface: "#FFFFFF",
  surfaceRaised: "#F4F0E6",
  border: "#E3DCCC",
  ink: "#14120E",
  inkSoft: "#57513F",
  inkFaint: "#8C8574",
  accent: "#8C4A2F",
  accentSoft: "#F0E2DA",
  danger: "#9B2C2C",
  success: "#2F6B4F",
  overlay: "rgba(20, 18, 14, 0.45)",
};

const dark: Palette = {
  bg: "#14120E",
  surface: "#1D1A15",
  surfaceRaised: "#272319",
  border: "#3A342A",
  ink: "#F4F0E6",
  inkSoft: "#B5AE9C",
  inkFaint: "#7C7565",
  accent: "#D98B6A",
  accentSoft: "#33251E",
  danger: "#E08585",
  success: "#7FB89A",
  overlay: "rgba(0, 0, 0, 0.6)",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 6,
  md: 12,
  lg: 20,
  pill: 999,
} as const;

/** The user's own words are set in a serif. Everything the app says is not. */
export const fonts = {
  prose: Platform.select({ ios: "Georgia", android: "serif", default: "Georgia, serif" }),
  ui: Platform.select({ ios: "System", android: "sans-serif", default: "system-ui" }),
  mono: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
} as const;

/**
 * The type scale, declared as TextStyle so React Native validates it here
 * rather than at every call site. Weights are restricted to the values the
 * platform actually renders — an invented one silently falls back to regular
 * on Android, which is the kind of bug you only notice on someone else's phone.
 */
export const type = {
  display: { fontSize: 30, lineHeight: 36, fontWeight: "700" },
  title: { fontSize: 21, lineHeight: 28, fontWeight: "600" },
  heading: { fontSize: 17, lineHeight: 24, fontWeight: "600" },
  body: { fontSize: 16, lineHeight: 24, fontWeight: "400" },
  prose: { fontSize: 17, lineHeight: 28, fontWeight: "400" },
  label: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "500" },
} satisfies Record<string, TextStyle>;

export function usePalette(): Palette {
  return useColorScheme() === "dark" ? dark : light;
}

export function useIsDark(): boolean {
  return useColorScheme() === "dark";
}

export const hairline = StyleSheet.hairlineWidth;

export { light as lightPalette, dark as darkPalette };
