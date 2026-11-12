// Quick (Ctrl/Cmd+K): one box that either sends what you type to the Stream, or finds a task by its name.
import { useEffect, useRef, useState } from "preact/hooks";
import type { ThreadRow } from "./api.ts";
import { ago, groupTasks, STATUS_WORD, SUGGESTIONS } from "./model.ts";
import { Knot } from "./Thread.tsx";

export function Quick({ threads, onSubmit, onOpenTask }: { threads: ThreadRow[]; onSubmit(text: string): Promise<boolean>; onOpenTask(id: string): void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => input.current?.focus({ preventScroll: true }), []);

  const g = groupTasks(threads, 200);
  const all = [...g.needsYou, ...g.working, ...g.done];
  const q = text.trim().toLowerCase();
  // Typing narrows the tasks by name; with an empty box, the newest ones.
  const found = q ? all.filter((t) => t.title.toLowerCase().includes(q)).slice(0, 6) : [...all].sort((a, b) => b.updated_at - a.updated_at).slice(0, 6);
  const now = Date.now();

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    const ok = await onSubmit(text.trim()).catch((err: Error) => (setError(err.message), false));
    setBusy(false);
    if (ok) setText("");
  };

  // Up and down move between the box and the tasks; Enter on a task opens it.
  const rows = () => [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const r = rows();
    const i = r.indexOf(document.activeElement as HTMLButtonElement);
    const j = e.key === "ArrowDown" ? i + 1 : i - 1;
    e.preventDefault();
    if (j < 0) input.current?.focus();
    else r[Math.min(j, r.length - 1)]?.focus();
  };

  return (
    <div class="quick is-overlay" onKeyDown={onKey}>
      <form class="quick-form" onSubmit={submit}>
        <input
          ref={input}
          class="quick-input"
          aria-label="Send to the Stream or find a task"
          placeholder="Ask something, or type a task's name…"
          autocomplete="off"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <button class="btn primary" type="submit" disabled={!text.trim() || busy}>Send</button>
      </form>
      {error && <div class="notice error">{error}</div>}
      {!q && (
        <div class="suggest" role="group" aria-label="Ideas to start with">
          {SUGGESTIONS.map((s) => (
            <button type="button" class="suggestion" onClick={() => { setText(`${s} `); input.current?.focus(); }}>{s}</button>
          ))}
        </div>
      )}
      <section class="recent" aria-labelledby="quick-found">
        <h2 class="group-h" id="quick-found">{q ? (found.length ? "Tasks with that name" : "No task with that name. Enter sends it to the Stream.") : "Recent tasks"}</h2>
        {found.length > 0 && (
          <ul ref={list}>
            {found.map((t) => (
              <li key={t.id}>
                <button class={`recent-row s-${t.status}`} onClick={() => onOpenTask(t.id)}>
                  <Knot status={t.status} />
                  <span class="row-title">{t.title}</span>
                  <span class="row-sub">{STATUS_WORD[t.status]} · {ago(t.updated_at, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
