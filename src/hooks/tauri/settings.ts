import { useCallback, useEffect, useState } from "react";
import { logInvokeError, tauriInvoke } from "./invoke";
import type { AppSettings } from "./types";

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<AppSettings>("get_settings");
      setSettings(result);
    } catch (e) {
      logInvokeError("useSettings", "Failed to get settings", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const update = useCallback(async (newSettings: AppSettings) => {
    await tauriInvoke("update_settings", { settings: newSettings });
    setSettings(newSettings);
  }, []);

  return { settings, loading, update, refresh };
}

