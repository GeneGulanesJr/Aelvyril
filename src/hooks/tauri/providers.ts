import { useCallback, useEffect, useState } from "react";
import { logInvokeError, tauriInvoke } from "./invoke";
import type { Provider } from "./types";

export function useProviders() {
  const [providers, setProviders] = useState<Provider[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<Provider[]>("list_providers");
      setProviders(result);
    } catch (e) {
      logInvokeError("useProviders", "Failed to list providers", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = useCallback(
    async (name: string, baseUrl: string, models: string[], apiKey: string) => {
      const result = await tauriInvoke<Provider>("add_provider", {
        name,
        baseUrl,
        models,
        apiKey,
      });
      setProviders((prev) => [...prev, result]);
      return result;
    },
    []
  );

  const fetchModels = useCallback(
    async (baseUrl: string, apiKey: string, timeoutSecs?: number) => {
      return await tauriInvoke<string[]>("fetch_models", {
        baseUrl,
        apiKey,
        timeoutSecs,
      });
    },
    []
  );

  const remove = useCallback(async (name: string) => {
    await tauriInvoke("remove_provider", { name });
    setProviders((prev) => prev.filter((p) => p.name !== name));
  }, []);

  return { providers, add, fetchModels, remove, refresh };
}

