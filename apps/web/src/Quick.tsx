// Quick: one big box for "what do you need?", plus recent tasks. Also the Ctrl/Cmd+K overlay.
import { useEffect, useRef, useState } from "preact/hooks";
import type { ThreadRow } from "./api.ts";
import { ago, groupTasks, STATUS_WORD, SUGGESTIONS } from "./model.ts";
import { Knot } from "./Thread.tsx";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function Quick({
  threads,
  overlay,
  active,
  onSubmit,
  onOpenTask,
}: {
  threads: ThreadRow[];
  overlay?: boolean;
  /** Focus the box when the view becomes visible. */
  active: boolean;
  onSubmit(text: string): Promise<boolean>;
  onOpenTask(id: string): void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  // Only the overlay takes focus by itself; the view leaves focus on the tabs for keyboard users.
  useEffect(() => {
    if (active && overlay) input.current?.focus({ preventScroll: true });
  }, [active]);

  const g = groupTasks(threads, 8);
  const recent = [...g.needsYou, ...g.working, ...g.done].sort((a, b) => b.updated_at - a.updated_at).slice(0, 6);
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

  return (
    <div class={`quick ${overlay ? "is-overlay" : ""}`}>
      <form class="quick-form" onSubmit={submit}>
        <input
          ref={input}
          class="quick-input"
          aria-label="What do you need?"
          placeholder="What do you need?"
          autocomplete="off"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <button class="btn primary" type="submit" disabled={!text.trim() || busy}>Send to Stream</button>
      </form>
      {error && <div class="notice error">{error}</div>}
      <div class="suggest" role="group" aria-label="Ideas to start with">
        {SUGGESTIONS.map((s) => (
          <button type="button" class="suggestion" onClick={() => { setText(`${s} `); input.current?.focus(); }}>{s}</button>
        ))}
      </div>
      {recent.length > 0 && (
        <section class="recent" aria-labelledby={overlay ? "recent-o" : "recent-v"}>
          <h2 class="group-h" id={overlay ? "recent-o" : "recent-v"}>Recent tasks</h2>
          <ul>
            {recent.map((t) => (
              <li key={t.id}>
                <button class={`recent-row s-${t.status}`} onClick={() => onOpenTask(t.id)}>
                  <Knot status={t.status} />
                  <span class="row-title">{t.title}</span>
                  <span class="row-sub">{STATUS_WORD[t.status]} · {ago(t.updated_at, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!overlay && <p class="muted small hint">Press <kbd>{isMac ? "⌘" : "Ctrl"}</kbd> <kbd>K</kbd> to open this box from anywhere.</p>}
    </div>
  );
}
