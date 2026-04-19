import { useCallback, useEffect, useState } from "react";
import { logInvokeError, tauriInvoke } from "./invoke";
import type { GatewayStatus } from "./types";

export function useGatewayStatus() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<GatewayStatus>("get_gateway_status");
      setStatus(result);
    } catch (e) {
      logInvokeError("useGatewayStatus", "Failed to get gateway status", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { status, loading, refresh };
}

export function useGatewayKey() {
  const [key, setKey] = useState<string | null>(null);

  const generate = useCallback(async () => {
    const newKey = await tauriInvoke<string>("generate_gateway_key");
    setKey(newKey);
    return newKey;
  }, []);

  return { key, generate };
}

