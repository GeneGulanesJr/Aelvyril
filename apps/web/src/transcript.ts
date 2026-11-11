// Turns the gateway's event log into what the thread view shows.
// Pure function: the same events always give the same screen, so a reload loses nothing.
import { PANEL_TYPE, parsePanel, type Panel } from "@aelvyril/ui-schema";

export interface Ev {
  seq: number;
  type: string;
  [k: string]: any;
}

export type DialogState = "pending" | "resolved" | "dead";

/** The gateway starts the message that hands a finished task's result to the main conversation with this line; people never see it. */
export const JOB_MARKER = "[aelvyril:job-result]";
/** Starts the message the gateway sends when the person taps "Try again"; shown as a short notice. */
export const RETRY_MARKER = "[aelvyril:retry]";

export type JobState = "working" | "needs_you" | "done" | "failed" | "stopped";

export type Item =
  | { kind: "user"; key: string; text: string; at?: number }
  | { kind: "assistant"; key: string; text: string; at?: number }
  | { kind: "tool"; key: string; name: string; args: unknown; output: string; isError: boolean; done: boolean }
  | { kind: "job"; key: string; jobId: string; title: string; state: JobState; preview: string }
  | { kind: "panel"; key: string; panel: Panel }
  | { kind: "notice"; key: string; text: string; level: "info" | "warning" | "error" }
  | { kind: "dialog"; key: string; id: string; method: string; title: string; message?: string; options?: string[]; placeholder?: string; state: DialogState };

export interface Transcript {
  items: Item[];
  running: boolean;
  status: Record<string, string>;
  widgets: Record<string, string[]>;
}

const text = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b?.type === "text" ? b.text : "")).join("");
};

export function buildTranscript(events: Ev[]): Transcript {
  const items: Item[] = [];
  const status: Record<string, string> = {};
  const widgets: Record<string, string[]> = {};
  const tools = new Map<string, Extract<Item, { kind: "tool" }>>();
  const panelAt = new Map<string, number>();
  let running = false;
  let lastHostStart = 0;
  const dialogs = new Map<string, Extract<Item, { kind: "dialog" }>>();
  const jobs = new Map<string, Extract<Item, { kind: "job" }>>();

  for (const e of events) {
    const key = String(e.seq);
    switch (e.type) {
      case "aelvyril_host_start":
        lastHostStart = e.seq;
        running = false;
        break;
      case "aelvyril_host_exit":
        running = false;
        break;
      case "agent_start":
        running = true;
        break;
      case "agent_settled":
        running = false;
        break;
      case "message_end": {
        const m = e.message ?? {};
        // When it was said, for day separators (only set when the message carries a time).
        const at = typeof m.timestamp === "number" ? { at: m.timestamp as number } : {};
        if (m.role === "user") {
          const t = text(m.content);
          if (t.startsWith(RETRY_MARKER)) items.push({ kind: "notice", key, text: "Trying again.", level: "info" });
          else if (!t.startsWith(JOB_MARKER)) items.push({ kind: "user", key, text: t, ...at });
        }
        else if (m.role === "assistant") {
          const t = text(m.content);
          if (t) items.push({ kind: "assistant", key, text: t, ...at });
          if (m.stopReason === "error" && m.errorMessage) items.push({ kind: "notice", key: key + "e", text: String(m.errorMessage), level: "error" });
        }
        break;
      }
      case "aelvyril_job_started": {
        const j = { kind: "job" as const, key, jobId: e.jobId, title: String(e.title ?? "Task"), state: "working" as JobState, preview: "" };
        jobs.set(e.jobId, j);
        items.push(j);
        break;
      }
      case "aelvyril_job_update": {
        let j = jobs.get(e.jobId);
        if (!j) {
          j = { kind: "job", key, jobId: e.jobId, title: String(e.title ?? "Task"), state: "working", preview: "" };
          jobs.set(e.jobId, j);
          items.push(j);
        }
        j.state = e.state as JobState;
        if (e.preview) j.preview = String(e.preview);
        break;
      }
      case "tool_execution_start": {
        // Starting or finishing a task shows as a task card and its summary, not as a tool line.
        if (e.toolName === "start_job" || e.toolName === "finish_task") break;
        const t = { kind: "tool" as const, key, name: e.toolName, args: e.args, output: "", isError: false, done: false };
        tools.set(e.toolCallId, t);
        items.push(t);
        break;
      }
      case "tool_execution_end": {
        const t = tools.get(e.toolCallId);
        if (t) Object.assign(t, { output: text(e.result?.content), isError: !!e.isError, done: true });
        break;
      }
      case "entry_appended": {
        const en = e.entry;
        // A task that finished says how it checked its work; show that, it is what makes "done" believable.
        if (en?.type === "custom" && en.customType === "aelvyril.task_outcome" && en.data?.outcome === "done" && en.data.verified) {
          items.push({ kind: "notice", key, text: `How it was checked: ${en.data.verified}`, level: "info" });
          break;
        }
        if (en?.type === "custom" && en.customType === PANEL_TYPE) {
          const r = parsePanel(en.data);
          if (!r.ok) {
            items.push({ kind: "notice", key, text: `Can't display a panel from an extension: ${r.error}`, level: "warning" });
          } else {
            const at = panelAt.get(r.panel.id);
            const item: Item = { kind: "panel", key: at === undefined ? key : items[at].key, panel: r.panel };
            if (at === undefined) {
              panelAt.set(r.panel.id, items.length);
              items.push(item);
            } else items[at] = item; // same id = update in place
          }
        }
        break;
      }
      case "extension_ui_request":
        if (e.method === "notify" && /^Ponytail loaded/i.test(String(e.message ?? ""))) {
          // an extension's startup confirmation: useful to a developer, noise for everyone else
        } else if (e.method === "notify") items.push({ kind: "notice", key, text: String(e.message ?? ""), level: e.notifyType === "error" ? "error" : e.notifyType === "warning" ? "warning" : "info" });
        else if (e.method === "setStatus") e.statusText ? (status[e.statusKey] = e.statusText) : delete status[e.statusKey];
        else if (e.method === "setWidget") e.widgetLines?.length ? (widgets[e.widgetKey] = e.widgetLines) : delete widgets[e.widgetKey];
        else if (["select", "confirm", "input", "editor"].includes(e.method)) {
          const d = { kind: "dialog" as const, key, id: e.id, method: e.method, title: e.title ?? "", message: e.message, options: e.options, placeholder: e.placeholder, state: "pending" as DialogState };
          dialogs.set(e.id, d);
          items.push(d);
        }
        break;
      case "aelvyril_ui_resolved": {
        const d = dialogs.get(e.id);
        if (d) d.state = "resolved";
        break;
      }
      case "extension_error":
        items.push({ kind: "notice", key, text: `Extension error: ${e.error ?? e.message ?? "unknown"}`, level: "error" });
        break;
      case "auto_retry_start":
        items.push({ kind: "notice", key, text: `Retrying (${e.attempt}/${e.maxAttempts}): ${e.errorMessage ?? ""}`, level: "warning" });
        break;
    }
  }
  // A dialog from before the last restart of the child can never be answered.
  for (const d of dialogs.values()) if (d.state === "pending" && Number(d.key) < lastHostStart) d.state = "dead";
  return { items, running, status, widgets };
}
