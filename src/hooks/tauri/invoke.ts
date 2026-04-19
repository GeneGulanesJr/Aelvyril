import { invoke } from "@tauri-apps/api/core";
import { logger } from "../../utils/logger";

export async function tauriInvoke<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  return await invoke<T>(command, args);
}

export function logInvokeError(component: string, message: string, e: unknown) {
  logger.error(message, { component, error: String(e) });
}

