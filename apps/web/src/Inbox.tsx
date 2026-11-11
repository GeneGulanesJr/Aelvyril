// Inbox: every task by what it needs from you. Desktop: list and the chosen task side by side.
import type { ThreadRow } from "./api.ts";
import { ago, groupTasks, plainPreview, STATUS_WORD } from "./model.ts";
import { Knot } from "./Thread.tsx";
import { TaskView } from "./Task.tsx";

const GROUPS = [
  { key: "needsYou", title: "Needs you" },
  { key: "working", title: "Working" },
  { key: "done", title: "Done" },
  { key: "chats", title: "Older chats" },
] as const;

export function Inbox({
  threads,
  rows,
  selected,
  phone,
  onSelect,
  onChanged,
}: {
  threads: ThreadRow[];
  rows: Map<string, ThreadRow>;
  /** The open task, if any (from the address). */
  selected: string | null;
  phone: boolean;
  onSelect(id: string): void;
  onChanged(): void;
}) {
  const g = groupTasks(threads);
  const all = [...g.needsYou, ...g.working, ...g.done, ...g.chats];
  // On a wide screen the right side is never blank: show the most urgent task.
  const shown = selected && rows.has(selected) ? selected : phone ? null : all[0]?.id ?? null;
  const now = Date.now();

  return (
    <div class="inbox">
      <nav class="rail scroll" aria-label="Tasks">
        {all.length === 0 && <p class="rail-empty">Nothing here yet. When the Stream starts a task, it shows up here.</p>}
        {GROUPS.map(({ key, title }) => {
          const list = g[key];
          if (!list.length) return null;
          return (
            <section class="group" key={key} aria-labelledby={`g-${key}`}>
              <h2 class="group-h" id={`g-${key}`}>{title}<span class="count">{list.length}</span></h2>
              <ul>
                {list.map((t) => (
                  <li key={t.id}>
                    <button class={`row-item s-${t.status}`} aria-current={t.id === shown ? "true" : undefined} onClick={() => onSelect(t.id)}>
                      <Knot status={t.status} />
                      <span class="row-text">
                        <span class="row-title">{t.title}</span>
                        <span class="row-sub">
                          {t.status === "needs_you" ? "Waiting for your answer" : plainPreview(t.preview) || STATUS_WORD[t.status]}
                        </span>
                      </span>
                      <span class="row-when">{ago(t.updated_at, now)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </nav>
      {!phone && (
        <div class="inbox-detail">
          {shown ? (
            <TaskView key={shown} id={shown} row={rows.get(shown)} rows={rows} mode="pane" backLabel="Back to Inbox" onClose={() => {}} onChanged={onChanged} onOpenTask={onSelect} />
          ) : (
            <div class="pane-empty">
              <div class="swatch" aria-hidden="true" />
              <p class="muted">Tasks appear here when the Stream starts one.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
