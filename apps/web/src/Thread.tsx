// Shared pieces of every conversation: the event stream, the woven transcript, task cards, the box.
import { Fragment, type Ref } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, type ModelRow, type ThreadRow } from "./api.ts";
import { buildTranscript, type Ev, type Item, type Transcript } from "./transcript.ts";
import { Markdown, PanelView } from "./Panel.tsx";
import { cardStatus, plainPreview, STATUS_WORD, stepWords, withDays, type Day, type Status } from "./model.ts";
import { IconArrow } from "./icons.tsx";

/** Live events of one thread. `tail` loads only the newest stored events (the Stream is endless). */
export function useThread(id: string | null, tail: number, onChanged: () => void): { t: Transcript; live: string; loaded: boolean } {
  const [events, setEvents] = useState<Ev[]>([]);
  const [live, setLive] = useState("");
  const [loaded, setLoaded] = useState(false);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  useEffect(() => {
    setEvents([]);
    setLive("");
    setLoaded(false);
    if (!id) return;
    let last = 0;
    let buffer: Ev[] = [];
    let timer = 0;
    // Replays arrive in bursts of hundreds: add them in one render, not one each.
    const flush = () => {
      timer = 0;
      const add = buffer;
      buffer = [];
      setEvents((s) => [...s, ...add]);
      setLoaded(true);
    };
    const es = new EventSource(`/api/threads/${id}/events${tail ? `?tail=${tail}` : ""}`);
    es.onopen = () => (timer ||= window.setTimeout(flush, 60));
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as Ev;
      if (e.type === "message_update") {
        const d = e.assistantMessageEvent;
        if (d?.type === "text_delta") setLive((s) => s + d.delta);
        return;
      }
      if (e.seq && e.seq <= last) return;
      if (e.seq) last = e.seq;
      if (e.type === "message_end" && e.message?.role === "assistant") setLive("");
      buffer.push(e);
      timer ||= window.setTimeout(flush, 30);
      if (e.type === "agent_settled" || e.type === "aelvyril_ui_resolved" || e.type === "extension_ui_request" || e.type.startsWith("aelvyril_job")) changed.current();
    };
    return () => {
      es.close();
      clearTimeout(timer);
    };
  }, [id, tail]);

  const t = useMemo(() => buildTranscript(events), [events]);
  return { t, live, loaded };
}

/** Keeps a transcript pinned to the newest line, unless the person scrolled up to read. */
export function useStickToBottom(dep: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => (pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    el.addEventListener("scroll", on, { passive: true });
    return () => el.removeEventListener("scroll", on);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, dep);
  return ref;
}

export interface WeaveProps {
  t: Transcript;
  live: string;
  threadId: string;
  label: string;
  rows: Map<string, ThreadRow>;
  onCommand(c: string): void;
  onOpenTask(id: string): void;
  working?: boolean;
  /** The Stream's look: a log with a small speaker label on each entry, and tool calls folded into one "Worked" line. */
  log?: boolean;
  /** What to call the assistant in the log's labels. */
  assistant?: string;
}

/** The woven transcript: day picks, your bands, answers, task cards, tool stitches, requests.
    In log mode (the Stream) a run of tool calls folds into one "Worked" line and thinking never shows. */
export function Weave({ t, live, threadId, label, rows, onCommand, onOpenTask, working, log, assistant = "Aelvyril" }: WeaveProps) {
  const items = useMemo(() => {
    const days = withDays<Item>(t.items, Date.now());
    if (!log) return days;
    const out: (typeof days[number] | { kind: "worked"; key: string; tools: Extract<Item, { kind: "tool" }>[] })[] = [];
    for (const it of days) {
      const last = out[out.length - 1];
      if (it.kind !== "tool") out.push(it);
      else if (last?.kind === "worked") last.tools.push(it);
      else out.push({ kind: "worked", key: `w${it.key}`, tools: [it] });
    }
    return out;
  }, [t.items, log]);
  // In the log, the speaker's label shows once per run of their messages, and a thin rule starts each of your new exchanges.
  let prev = "";
  const shown = items.map((it) => {
    if (it.kind === "day") return (prev = ""), <DayPick key={it.key} day={it} />;
    if (it.kind === "worked") return <Worked key={it.key} tools={it.tools} />;
    const who = it.kind === "user" ? "you" : it.kind === "assistant" ? "ai" : "";
    const label = !!log && !!who && who !== prev;
    const rule = !!log && it.kind === "user" && prev !== "" && prev !== "you";
    if (who) prev = who;
    return (
      <Fragment key={it.key}>
        {rule && <hr class="turn-rule" aria-hidden="true" />}
        <ItemView item={it} threadId={threadId} rows={rows} log={label} assistant={assistant} onCommand={onCommand} onOpenTask={onOpenTask} />
      </Fragment>
    );
  });
  return (
    <section class={`weave ${working ? "working" : ""} ${log ? "log" : ""}`} aria-label={label}>
      {shown}
      {live && <div class="msg assistant live" aria-hidden="true">{log && prev !== "ai" && <Who name={assistant} />}<Markdown text={live} /></div>}
      {Object.entries(t.widgets).map(([k, lines]) => <pre key={k} class="widget">{lines.join("\n")}</pre>)}
    </section>
  );
}

/** Who is speaking, as a small label on top of an entry in the log. */
const Who = ({ name }: { name: string }) => <span class="who">{name}</span>;

/** A run of tool calls, folded: "Worked · 3 steps". The details are one click away, never in the way. */
function Worked({ tools }: { tools: Extract<Item, { kind: "tool" }>[] }) {
  const busy = tools.some((x) => !x.done);
  const failed = tools.filter((x) => x.isError).length;
  const steps = `${tools.length} ${tools.length === 1 ? "step" : "steps"}`;
  return (
    <details class={`worked ${busy ? "busy" : ""} ${failed ? "failed" : ""}`}>
      <summary>{busy ? "Working" : "Worked"} · {steps}{failed ? ` · ${failed} didn't work` : ""}</summary>
      <div class="worked-list">{tools.map((x) => <ToolRow key={x.key} item={x} />)}</div>
    </details>
  );
}

const DayPick = ({ day }: { day: Day }) => <h2 class="day"><span>{day.label}</span></h2>;

function ToolRow({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const { what, detail } = stepWords(item.name, item.args);
  return (
    <details class={`tool ${item.isError ? "err" : item.done ? "done" : ""}`}>
      <summary>
        <span class="tool-state" aria-label={item.isError ? "Didn't work" : item.done ? "Done" : "Running"}>{item.isError ? "✕" : item.done ? "✓" : "…"}</span>
        <span class="tool-name">{what}</span>
        {detail && <span class="muted tool-args">{detail.slice(0, 120)}</span>}
      </summary>
      <pre class="tool-input">{item.name} {JSON.stringify(item.args, null, 2).slice(0, 4000)}</pre>
      {item.output && <pre>{item.output.slice(0, 4000)}</pre>}
    </details>
  );
}

/** What's going on, as small chips: one per task, needs-you first. One tap opens the task. */
export function TaskChips({ list, label, onOpen, onMore, max = 3 }: { list: ThreadRow[]; label: string; onOpen(id: string): void; onMore?(): void; max?: number }) {
  if (!list.length) return null;
  const shown = list.slice(0, max);
  return (
    <div class="home-tasks" role="group" aria-label={label}>
      {shown.map((t) => (
        <button key={t.id} class={`htask s-${t.status}`} onClick={() => onOpen(t.id)} aria-label={`${t.title}, ${STATUS_WORD[t.status]}. Open task`}>
          <Knot status={t.status} />
          <span class="htask-title">{t.title}</span>
          <span class="htask-state">{t.status === "needs_you" ? "Needs you" : STATUS_WORD[t.status]}</span>
        </button>
      ))}
      {list.length > shown.length && onMore && <button class="link htask-more" onClick={onMore}>+{list.length - shown.length} more</button>}
    </div>
  );
}

function ItemView({ item, threadId, rows, log, assistant, onCommand, onOpenTask }: { item: Item; threadId: string; rows: Map<string, ThreadRow>; log?: boolean; assistant: string; onCommand(c: string): void; onOpenTask(id: string): void }) {
  switch (item.kind) {
    case "user":
      return <div class="msg user">{log && <Who name="You" />}{item.text}</div>;
    case "assistant":
      return <div class="msg assistant">{log && <Who name={assistant} />}<Markdown text={item.text} /></div>;
    case "handoff":
      return null; // only there so the reply that follows can be filed under its task
    case "tool":
      return <ToolRow item={item} />;
    case "job":
      return <TaskCard item={item} row={rows.get(item.jobId)} onOpen={onOpenTask} />;
    case "panel":
      return <PanelView panel={item.panel} onCommand={onCommand} />;
    case "notice":
      return <div class={`notice ${item.level}`}>{item.text}</div>;
    case "dialog":
      return <DialogCard item={item} threadId={threadId} />;
  }
}

/** The state mark used everywhere: hollow = working, weld diamond = needs you, filled = done/failed. */
export const Knot = ({ status }: { status: Status }) => <span class={`knot k-${status}`} aria-hidden="true" />;

/**
 * A task tied onto the Stream. Working and waiting tasks stay open with their weft line (the shuttle
 * runs while it works, a weld knot pulses when it needs you); finished ones fold to one line.
 */
export function TaskCard({ item, row, onOpen }: { item: Extract<Item, { kind: "job" }>; row?: ThreadRow; onOpen(id: string): void }) {
  const status = cardStatus(item, row);
  const title = row?.title || item.title;
  const preview = plainPreview(row?.preview || item.preview);
  const open = status === "working" || status === "needs_you";
  const descId = `task-${item.key}-d`;
  const line =
    status === "needs_you" ? "It's waiting for your answer. Open it to reply." : status === "working" ? preview || "Getting started…" : preview;
  return (
    <button type="button" class={`task s-${status} ${open ? "open" : "folded"}`} onClick={() => onOpen(item.jobId)} aria-label={`${title}, ${STATUS_WORD[status]}. Open task`} aria-describedby={line ? descId : undefined}>
      <span class="task-head">
        <span class="task-title">{title}</span>
        <span class="task-state"><Knot status={status} />{STATUS_WORD[status]}</span>
      </span>
      {line && <span class="task-line" id={descId}>{line}</span>}
      {open && (
        <span class="task-foot">
          <span class="weft" aria-hidden="true"><span class="shuttle" /></span>
          <span class="task-go">{status === "needs_you" ? "Open to answer" : "Open"} <IconArrow /></span>
        </span>
      )}
      {!open && <IconArrow />}
    </button>
  );
}

export function StatusChip({ status }: { status: Status }) {
  return <span class={`chip status s-${status}`}><Knot status={status} />{STATUS_WORD[status]}</span>;
}

export function Composer({
  label,
  placeholder,
  value,
  onValue,
  onSend,
  running,
  onStop,
  inputRef,
}: {
  label: string;
  placeholder: string;
  value: string;
  onValue(v: string): void;
  onSend(text: string): void;
  running?: boolean;
  onStop?(): void;
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
  const send = () => {
    if (!value.trim()) return;
    onSend(value);
    onValue("");
  };
  return (
    <form class="composer" data-noswipe onSubmit={(e) => { e.preventDefault(); send(); }}>
      <textarea
        ref={inputRef}
        rows={2}
        value={value}
        aria-label={label}
        placeholder={placeholder}
        onInput={(e) => onValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div class="composer-actions">
        {running && onStop && <button type="button" class="btn danger" onClick={onStop}>Stop</button>}
        <button type="submit" class="btn primary" disabled={!value.trim()}>Send</button>
      </div>
    </form>
  );
}

export function ModelPicker({ threadId, onError }: { threadId: string; onError(m: string): void }) {
  const [models, setModels] = useState<ModelRow[]>([]);
  useEffect(() => void api.models().then(setModels).catch(() => {}), []);
  if (!models.length) return null;
  return (
    <select
      aria-label="Model"
      class="model-pick"
      onChange={(e) => {
        const [provider, ...rest] = e.currentTarget.value.split("/");
        if (provider) api.setModel(threadId, provider, rest.join("/")).catch((err) => onError(err.message));
      }}
    >
      <option value="">Default AI</option>
      {models.map((m) => <option value={`${m.provider}/${m.id}`}>{m.provider} · {m.name ?? m.id}</option>)}
    </select>
  );
}

/** An extension is waiting on the user: Allow / Deny, a choice, or text. Survives reloads (it lives in the event log). */
function DialogCard({ item, threadId }: { item: Extract<Item, { kind: "dialog" }>; threadId: string }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const answer = (body: { value?: string; confirmed?: boolean; cancelled?: boolean }) => api.answer(threadId, { id: item.id, ...body }).catch((e) => setErr(e.message));
  if (item.state !== "pending") {
    return <div class="dialog done">{item.title} <span class="muted">{item.state === "dead" ? "— expired" : "— answered"}</span></div>;
  }
  return (
    <div class="dialog" role="alertdialog" aria-label={item.title}>
      <strong>{item.title}</strong>
      {item.message && <pre>{item.message}</pre>}
      {item.method === "confirm" && (
        <div class="row">
          <button class="btn primary" onClick={() => answer({ confirmed: true })}>Allow</button>
          <button class="btn" onClick={() => answer({ confirmed: false })}>Deny</button>
        </div>
      )}
      {item.method === "select" && (
        <div class="row">
          {item.options?.map((o) => <button class="btn" onClick={() => answer({ value: o })}>{o}</button>)}
          <button class="btn link" onClick={() => answer({ cancelled: true })}>Cancel</button>
        </div>
      )}
      {(item.method === "input" || item.method === "editor") && (
        <div class="row">
          <input value={text} placeholder={item.placeholder} onInput={(e) => setText(e.currentTarget.value)} />
          <button class="btn primary" onClick={() => answer({ value: text })}>Submit</button>
          <button class="btn link" onClick={() => answer({ cancelled: true })}>Cancel</button>
        </div>
      )}
      {err && <div class="notice error">{err}</div>}
    </div>
  );
}
