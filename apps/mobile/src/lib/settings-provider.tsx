import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  SettingsContext,
  emptySettings,
  loadSettings,
  saveSettings,
  type WorkerSettings,
} from "./settings";

export function SettingsProvider({ children }: { children: ReactNode }): ReactNode {
  const [settings, setSettings] = useState<WorkerSettings>(emptySettings);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void loadSettings()
      .then((loaded) => {
        if (!cancelled) setSettings(loaded);
      })
      // A keychain read can fail on a locked device. The app stays fully usable
      // without a worker — capture, notes and search are all local.
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(async (next: WorkerSettings) => {
    await saveSettings(next);
    setSettings({ baseUrl: next.baseUrl, token: next.token });
  }, []);

  const value = useMemo(() => ({ settings, loading, update }), [settings, loading, update]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}
