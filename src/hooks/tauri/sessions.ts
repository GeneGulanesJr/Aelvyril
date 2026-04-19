import { useCallback, useEffect, useState } from "react";
import { logInvokeError, tauriInvoke } from "./invoke";
import type { Session } from "./types";

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<Session[]>("list_sessions");
      setSessions(result);
    } catch (e) {
      logInvokeError("useSessions", "Failed to list sessions", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const clear = useCallback(async (sessionId: string) => {
    await tauriInvoke("clear_session", { sessionId });
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
  }, []);

  return { sessions, clear, refresh };
}

