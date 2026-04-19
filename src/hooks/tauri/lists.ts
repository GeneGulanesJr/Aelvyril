import { useCallback, useEffect, useState } from "react";
import { logInvokeError, tauriInvoke } from "./invoke";
import type { ListRule } from "./types";

export function useAllowList() {
  const [rules, setRules] = useState<ListRule[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<ListRule[]>("list_allow_rules");
      setRules(result);
    } catch (e) {
      logInvokeError("useAllowList", "Failed to list allow rules", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = useCallback(async (pattern: string, label: string) => {
    const rule = await tauriInvoke<ListRule>("add_allow_rule", { pattern, label });
    setRules((prev) => [...prev, rule]);
    return rule;
  }, []);

  const remove = useCallback(async (id: string) => {
    await tauriInvoke("remove_allow_rule", { id });
    setRules((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const toggle = useCallback(async (id: string, enabled: boolean) => {
    await tauriInvoke("toggle_allow_rule", { id, enabled });
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled } : r)));
  }, []);

  return { rules, add, remove, toggle, refresh };
}

export function useDenyList() {
  const [rules, setRules] = useState<ListRule[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<ListRule[]>("list_deny_rules");
      setRules(result);
    } catch (e) {
      logInvokeError("useDenyList", "Failed to list deny rules", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = useCallback(async (pattern: string, label: string) => {
    const rule = await tauriInvoke<ListRule>("add_deny_rule", { pattern, label });
    setRules((prev) => [...prev, rule]);
    return rule;
  }, []);

  const remove = useCallback(async (id: string) => {
    await tauriInvoke("remove_deny_rule", { id });
    setRules((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const toggle = useCallback(async (id: string, enabled: boolean) => {
    await tauriInvoke("toggle_deny_rule", { id, enabled });
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled } : r)));
  }, []);

  return { rules, add, remove, toggle, refresh };
}

