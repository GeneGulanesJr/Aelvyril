// One task (or older chat) on its own: its status, its conversation, Stop, and a reply box.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, type ThreadRow } from "./api.ts";
import { Composer, ModelPicker, StatusChip, useStickToBottom, useThread, Weave } from "./Thread.tsx";
import { IconBack, IconClose } from "./icons.tsx";

export type TaskMode = "sheet" | "full" | "pane";

export function TaskView({
  id,
  row,
  rows,
  mode,
  backLabel,
  onClose,
  onChanged,
  onOpenTask,
}: {
  id: string;
  row?: ThreadRow;
  rows: Map<string, ThreadRow>;
  mode: TaskMode;
  /** Phone: where Back goes ("Back to Stream"). */
  backLabel: string;
  onClose(): void;
  onChanged(): void;
  onOpenTask(id: string): void;
}) {
  const { t, live } = useThread(id, 0, onChanged);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [asking, setAsking] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const scroller = useStickToBottom([t.items.length, live]);

  useEffect(() => {
    setDraft("");
    setError("");
    setAsking(false);
    if (mode !== "pane") heading.current?.focus({ preventScroll: true });
  }, [id]);

  const status = row?.status ?? (t.running ? "working" : "done");
  const working = status === "working" || t.running;
  const isChat = row?.kind === "chat";
  const title = row?.title ?? "Task";

  const send = async (message: string) => {
    if (!message.trim()) return;
    setError("");
    try {
      await api.prompt(id, message);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div class={`taskview m-${mode}`}>
      <header class="task-bar">
        {mode === "full" && (
          <button class="link back" onClick={onClose}><IconBack />{backLabel}</button>
        )}
        <div class="task-bar-main">
          <h2 ref={heading} tabIndex={-1}>{title}</h2>
          <div class="row">
            <StatusChip status={status} />
            {isChat && <span class="muted small">Older chat</span>}
            {isChat && <ModelPicker threadId={id} onError={setError} />}
          </div>
        </div>
        <div class="task-bar-actions">
          {(status === "failed" || status === "stopped") && !isChat && (
            <button class="btn primary" onClick={() => api.retry(id).then(onChanged).catch((e) => setError(e.message))}>Try again</button>
          )}
          {working && <button class="btn danger" onClick={() => api.abort(id).then(onChanged).catch((e) => setError(e.message))}>Stop</button>}
          {asking ? (
            <span class="row">
              <button class="btn danger" onClick={async () => { await api.deleteThread(id).catch((e) => setError(e.message)); onChanged(); onClose(); }}>Delete?</button>
              <button class="link" onClick={() => setAsking(false)}>Cancel</button>
            </span>
          ) : (
            <button class="link" onClick={() => setAsking(true)}>Delete</button>
          )}
          {mode === "sheet" && (
            <button class="icon-btn" aria-label="Close task" onClick={onClose}><IconClose /></button>
          )}
        </div>
      </header>
      <div class="scroll transcript" ref={scroller}>
        <Weave t={t} live={live} threadId={id} label={`${title} conversation`} rows={rows} onCommand={send} onOpenTask={onOpenTask} working={working} />
      </div>
      {error && <div class="notice error bar-notice">{error} <button class="link" onClick={() => setError("")}>dismiss</button></div>}
      <Composer
        label="Reply to task"
        placeholder={status === "needs_you" ? "Answer the request above, or write here…" : working ? "Add something while it works…" : "Ask a follow-up…"}
        value={draft}
        onValue={setDraft}
        onSend={send}
      />
    </div>
  );
}
