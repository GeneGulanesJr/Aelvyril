// Tasks: a kanban of projects (boards), and inside each project a kanban of its tasks.
// A project sits in the column of its most urgent task: needs you, then working, then done. A task opens beside the board.
import { useState } from "preact/hooks";
import type { ThreadRow } from "./api.ts";
import { ago, COLUMNS, columnOf, plainPreview, projects, STATUS_WORD, type Project } from "./model.ts";
import { Knot } from "./Thread.tsx";
import { IconBack } from "./icons.tsx";
import { store } from "./store.ts";

export function Inbox({ threads, onOpenTask }: { threads: ThreadRow[]; onOpenTask(id: string): void }) {
  const list = projects(threads);
  const [openName, setOpenName] = useState<string | null>(() => store.get("aelvyril.board"));
  const open = list.find((p) => p.name === openName) ?? null;
  const pick = (name: string | null) => {
    setOpenName(name);
    store.set("aelvyril.board", name ?? "");
  };
  const now = Date.now();

  if (!list.length)
    return (
      <div class="kanban-page">
        <p class="kanban-empty">No tasks yet. When the Stream starts one, its project shows up here.</p>
      </div>
    );

  if (!open)
    return (
      <div class="kanban-page">
        <header class="kanban-head">
          <h2>Projects</h2>
          <span class="muted small">{list.length === 1 ? "1 project" : `${list.length} projects`}</span>
        </header>
        <div class="kanban">
          {COLUMNS.map((col) => {
            const here = list.filter((p) => p.column === col.key);
            return (
              <section key={col.key} class={`kcol c-${col.key}`} aria-label={col.title}>
                <h3 class="kcol-h">{col.title}<span class="count">{here.length}</span></h3>
                {here.map((p) => <ProjectCard key={p.name} p={p} now={now} onOpen={() => pick(p.name)} />)}
                {!here.length && <p class="kcol-empty">Nothing here</p>}
              </section>
            );
          })}
        </div>
      </div>
    );

  return (
    <div class="kanban-page">
      <header class="kanban-head">
        <button class="link back" onClick={() => pick(null)}><IconBack />All projects</button>
        <h2>{open.name}</h2>
        <span class="muted small">{open.tasks.length === 1 ? "1 task" : `${open.tasks.length} tasks`}</span>
      </header>
      <div class="kanban">
        {COLUMNS.map((col) => {
          const here = open.tasks.filter((t) => columnOf(t.status) === col.key);
          return (
            <section key={col.key} class={`kcol c-${col.key}`} aria-label={col.title}>
              <h3 class="kcol-h">{col.title}<span class="count">{here.length}</span></h3>
              {here.map((t) => (
                <button key={t.id} class={`kcard s-${t.status}`} onClick={() => onOpenTask(t.id)} aria-label={`${t.title}, ${STATUS_WORD[t.status]}. Open task`}>
                  <span class="kcard-top"><Knot status={t.status} /><span class="kcard-title">{t.title}</span></span>
                  <span class="kcard-line">{t.status === "needs_you" ? "Waiting for your answer" : plainPreview(t.preview) || STATUS_WORD[t.status]}</span>
                  <span class="kcard-foot">{STATUS_WORD[t.status]} · {ago(t.updated_at, now)}</span>
                </button>
              ))}
              {!here.length && <p class="kcol-empty">Nothing here</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** A project on the outer board: its name, how its tasks stand, and the newest one. */
function ProjectCard({ p, now, onOpen }: { p: Project; now: number; onOpen(): void }) {
  const n = (s: string) => p.tasks.filter((t) => columnOf(t.status) === s).length;
  const parts = [n("needs") && `${n("needs")} need you`, n("working") && `${n("working")} working`, n("done") && `${n("done")} done`].filter(Boolean);
  return (
    <button class={`kcard project c-${p.column}`} onClick={onOpen} aria-label={`${p.name}: ${parts.join(", ")}. Open project`}>
      <span class="kcard-title">{p.name}</span>
      <span class="kcard-knots" aria-hidden="true">{p.tasks.slice(0, 12).map((t) => <Knot key={t.id} status={t.status} />)}</span>
      <span class="kcard-line">{parts.join(" · ")}</span>
      <span class="kcard-foot">Latest: {p.tasks[0].title} · {ago(p.tasks[0].updated_at, now)}</span>
    </button>
  );
}
