import { useCallback, useEffect, useState } from "react";
import { logInvokeError, tauriInvoke } from "./invoke";
import type { DetectedTool } from "./types";

export function useOnboarding() {
  const [status, setStatus] = useState<{
    complete: boolean;
    has_key: boolean;
    has_providers: boolean;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<{
        complete: boolean;
        has_key: boolean;
        has_providers: boolean;
      }>("get_onboarding_status");
      setStatus(result);
    } catch (e) {
      logInvokeError("useOnboarding", "Failed to get onboarding status", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const complete = useCallback(async () => {
    await tauriInvoke("complete_onboarding");
    setStatus((prev) => (prev ? { ...prev, complete: true } : null));
  }, []);

  const detectTools = useCallback(async () => {
    const result = await tauriInvoke<{ tools: DetectedTool[] }>("detect_installed_tools");
    return result.tools;
  }, []);

  return { status, complete, detectTools, refresh };
}

