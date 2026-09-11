import * as SecureStore from "expo-secure-store";
import { createContext, useContext } from "react";
import { isConfigured, normaliseUrl, tierFromToken } from "./token";

export { isConfigured, normaliseUrl, tierFromToken };

/**
 * Where the compile service lives, and the credential for talking to it.
 *
 * The token goes in the device keychain rather than AsyncStorage: it authorises
 * spending against an account, so it belongs with the platform's secret storage
 * and not in a plaintext file any backup can read.
 *
 * The base URL is a setting rather than a constant because a developer runs the
 * worker on their own machine, and a user's deployment may not be ours.
 */

const URL_KEY = "loom.worker.url";
const TOKEN_KEY = "loom.worker.token";

export interface WorkerSettings {
  readonly baseUrl: string | null;
  readonly token: string | null;
}

export const emptySettings: WorkerSettings = { baseUrl: null, token: null };

export async function loadSettings(): Promise<WorkerSettings> {
  const [baseUrl, token] = await Promise.all([
    SecureStore.getItemAsync(URL_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
  ]);
  return { baseUrl: normaliseUrl(baseUrl), token };
}

export async function saveSettings(settings: WorkerSettings): Promise<void> {
  const url = normaliseUrl(settings.baseUrl);
  await Promise.all([
    url === null ? SecureStore.deleteItemAsync(URL_KEY) : SecureStore.setItemAsync(URL_KEY, url),
    settings.token === null || settings.token.length === 0
      ? SecureStore.deleteItemAsync(TOKEN_KEY)
      : SecureStore.setItemAsync(TOKEN_KEY, settings.token),
  ]);
}

export interface SettingsContextValue {
  readonly settings: WorkerSettings;
  readonly loading: boolean;
  readonly update: (next: WorkerSettings) => Promise<void>;
}

export const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (ctx === null) throw new Error("useSettings must be used inside a SettingsProvider");
  return ctx;
}
