import { useCallback } from "react";
import { tauriInvoke } from "./invoke";

export function useClipboard() {
  const toggle = useCallback(async (enabled: boolean) => {
    await tauriInvoke("toggle_clipboard_monitor", { enabled });
  }, []);

  const scan = useCallback(async (content: string) => {
    return await tauriInvoke("scan_clipboard_content", { content });
  }, []);

  const respond = useCallback(async (response: string) => {
    return await tauriInvoke("respond_to_clipboard", { response });
  }, []);

  return { toggle, scan, respond };
}

