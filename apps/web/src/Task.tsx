// One task (or older chat) on its own: its status, its conversation, Stop, and a reply box.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, type ThreadRow } from "./api.ts";
import { plainPreview } from "./model.ts";
import { Composer, ModelPicker, StatusChip, useStickToBottom, useThread, Weave } from "./Thread.tsx";
import { Markdown, PanelView } from "./Panel.tsx";
import type { Item } from "./transcript.ts";
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
            {row?.kind === "job" && <BoardPicker id={id} board={row.board || "General"} rows={rows} onMoved={onChanged} onError={setError} />}
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
            !working && <button class="link quiet" onClick={() => setAsking(true)}>Delete</button>
          )}
          {mode === "sheet" && (
            <button class="icon-btn" aria-label="Close task" onClick={onClose}><IconClose /></button>
          )}
        </div>
      </header>
      <div class="scroll transcript" ref={scroller}>
        {isChat ? (
          <Weave t={t} live={live} threadId={id} label={`${title} conversation`} rows={rows} onCommand={send} onOpenTask={onOpenTask} working={working} log />
        ) : (
          <TaskPage t={t} live={live} id={id} title={title} rows={rows} status={status} why={plainPreview(row?.preview ?? "")} working={working} onCommand={send} onOpenTask={onOpenTask} />
        )}
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

/** A task read top-down: what you asked, the result (or what it has so far), then how it went, folded once it's done. */
function TaskPage({ t, live, id, title, rows, status, why, working, onCommand, onOpenTask }: {
  t: ReturnType<typeof useThread>["t"]; live: string; id: string; title: string; rows: Map<string, ThreadRow>; status: string; why: string; working: boolean;
  onCommand(c: string): void; onOpenTask(id: string): void;
}) {
  const asked = t.items.find((i): i is Extract<Item, { kind: "user" }> => i.kind === "user");
  const answers = t.items.filter((i): i is Extract<Item, { kind: "assistant" }> => i.kind === "assistant");
  const answer = live || answers[answers.length - 1]?.text || "";
  // a panel that is updated in place keeps its id: show only its newest version
  const panels = [...new Map(t.items.flatMap((i) => (i.kind === "panel" ? [[i.panel.id, i.panel] as const] : []))).values()];
  const steps = t.items.filter((i) => i.kind === "tool").length;
  // notes since your last message ("Trying again.", an error) belong with the result, not folded away
  const lastAsk = t.items.lastIndexOf([...t.items].reverse().find((i) => i.kind === "user") as Item);
  const notes = t.items.slice(lastAsk + 1).filter((i): i is Extract<Item, { kind: "notice" }> => i.kind === "notice");
  const done = !working && status !== "needs_you";
  return (
    <div class="task-page">
      {asked && (
        <section class="tp-sec">
          <h3 class="tp-h">What you asked</h3>
          <p class="tp-asked">{asked.text}</p>
        </section>
      )}
      <section class={`tp-sec tp-result s-${status}`}>
        <h3 class="tp-h">{status === "needs_you" ? "Waiting for your answer" : done ? (status === "done" ? "Result" : "What happened") : "So far"}</h3>
        {(status === "failed" || status === "stopped") && why && <p class="tp-why">{why}</p>}
        {panels.map((p) => <PanelView key={p.id} panel={p} onCommand={onCommand} />)}
        {answer ? <div class="tp-answer"><Markdown text={answer} /></div> : <p class="muted">{working ? "Working on it…" : "No answer yet."}</p>}
        {notes.map((n) => <div key={n.key} class={`notice ${n.level}`}>{n.text}</div>)}
      </section>
      <details class="tp-how" open={!done} key={done ? "done" : "busy"}>
        <summary>How it went{steps ? ` · ${steps} ${steps === 1 ? "step" : "steps"}` : ""}</summary>
        <Weave t={t} live={live} threadId={id} label={`${title}: how it went`} rows={rows} onCommand={onCommand} onOpenTask={onOpenTask} working={working} log />
      </details>
    </div>
  );
}

/** Which project a task is on, and moving it: one of the boards there are, or a new one. */
function BoardPicker({ id, board, rows, onMoved, onError }: { id: string; board: string; rows: Map<string, ThreadRow>; onMoved(): void; onError(m: string): void }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const boards = [...new Set([board, ...[...rows.values()].filter((r) => r.kind === "job").map((r) => r.board || "General")])].sort();
  const move = (to: string) => {
    setNaming(false);
    if (to.trim() && to !== board) api.moveTask(id, to).then(onMoved).catch((e) => onError(e.message));
  };
  if (naming)
    return (
      <form class="row board-new" onSubmit={(e) => { e.preventDefault(); move(name); }}>
        <input aria-label="New board name" placeholder="New board name" value={name} maxLength={40} onInput={(e) => setName(e.currentTarget.value)} />
        <button class="btn" type="submit" disabled={!name.trim()}>Move</button>
        <button class="link" type="button" onClick={() => setNaming(false)}>Cancel</button>
      </form>
    );
  return (
    <select class="model-pick" aria-label="Board" value={board} onChange={(e) => (e.currentTarget.value === "\u0000new" ? (setName(""), setNaming(true)) : move(e.currentTarget.value))}>
      {boards.map((b) => <option value={b}>Board: {b}</option>)}
      <option value={"\u0000new"}>New board…</option>
    </select>
  );
}
