import { useCallback, useEffect, useState } from "react";
import { logInvokeError, tauriInvoke } from "./invoke";
import type {
  GlobalTokenStats,
  TokenStatsResponse,
  ToolTokenStats,
  ModelTokenStats,
  DailyTokenTrend,
  EfficiencyMetrics,
} from "./types";

/**
 * Hook to get global token usage stats for the dashboard.
 * Polls every 5 seconds to keep stats current.
 */
export function useTokenStats() {
  const [stats, setStats] = useState<GlobalTokenStats | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<GlobalTokenStats>("get_token_stats");
      setStats(result);
    } catch (e) {
      logInvokeError("useTokenStats", "Failed to get token stats", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { stats, loading, refresh };
}

/**
 * Hook to get full token stats response (L1-L4).
 */
export function useTokenStatsFull() {
  const [response, setResponse] = useState<TokenStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<TokenStatsResponse>("get_token_stats_full");
      setResponse(result);
    } catch (e) {
      logInvokeError("useTokenStatsFull", "Failed to get full token stats", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { response, loading, refresh };
}

/**
 * Hook to get per-tool token breakdown.
 */
export function useTokenStatsByTool() {
  const [tools, setTools] = useState<ToolTokenStats[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<ToolTokenStats[]>("get_token_stats_by_tool");
      setTools(result);
    } catch (e) {
      logInvokeError("useTokenStatsByTool", "Failed to get token stats by tool", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { tools, loading, refresh };
}

/**
 * Hook to get per-model token breakdown.
 */
export function useTokenStatsByModel() {
  const [models, setModels] = useState<ModelTokenStats[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<ModelTokenStats[]>("get_token_stats_by_model");
      setModels(result);
    } catch (e) {
      logInvokeError("useTokenStatsByModel", "Failed to get token stats by model", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { models, loading, refresh };
}

/**
 * Hook to get daily token trends.
 */
export function useTokenTrends() {
  const [trends, setTrends] = useState<DailyTokenTrend[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<DailyTokenTrend[]>("get_token_trends");
      setTrends(result);
    } catch (e) {
      logInvokeError("useTokenTrends", "Failed to get token trends", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { trends, loading, refresh };
}

/**
 * Hook to get efficiency metrics.
 */
export function useTokenEfficiency() {
  const [efficiency, setEfficiency] = useState<EfficiencyMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<EfficiencyMetrics>("get_token_efficiency");
      setEfficiency(result);
    } catch (e) {
      logInvokeError("useTokenEfficiency", "Failed to get token efficiency", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { efficiency, loading, refresh };
}

/**
 * Format cents to USD string.
 */
export function centsToUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Format token count with commas.
 */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return count.toString();
}

/**
 * Get a human-readable percentage.
 */
export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}