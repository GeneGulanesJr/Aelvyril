// Board: the same tasks as the Inbox, laid out as cards side by side with the results they produced.
// The person arranges them by dragging the stitched handle or with the Move buttons, and can fold any card.
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, type BoardState } from "./api.ts";
import { Markdown, PanelView } from "./Panel.tsx";
import { StatusChip } from "./Thread.tsx";
import { IconArrow, IconEarlier, IconFold, IconGrip, IconLater } from "./icons.tsx";
import { store } from "./store.ts";
import {
  ago,
  clip,
  dropTarget,
  gesture,
  mergeOrder,
  moveBy,
  moveTo,
  movedMessage,
  plainPreview,
  pruneCollapsed,
  readBoardPrefs,
  sameOrder,
  skippedLabel,
  STREAM_TILE,
  toggleCollapsed,
  validPanels,
  type BoardPrefs,
} from "./model.ts";

type Task = BoardState["tasks"][number];

const KEY = "aelvyril.board";
const POLL_MS = 4000;
const ROW = 4; // masonry row unit (px)
const GAP = 16; // space under each card (px)

export function Board({
  active,
  reduced,
  onOpenTask,
  onOpenStream,
  onChanged,
  announce,
}: {
  /** The Board is the view on screen: poll only then. */
  active: boolean;
  reduced: boolean;
  onOpenTask(id: string): void;
  onOpenStream(): void;
  onChanged(): void;
  announce(msg: string): void;
}) {
  const [data, setData] = useState<BoardState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [prefs, setPrefs] = useState<BoardPrefs>(() => readBoardPrefs(store.get(KEY)));
  const shown = useRef<string[] | null>(null);

  // ---- data: every 4 seconds while the Board is on screen (and the browser tab is visible)
  const load = useRef(() => {});
  load.current = () => {
    if (document.hidden) return;
    api
      .board()
      .then((d) => (setData(d), setLoadError("")))
      .catch((e: Error) => setLoadError(e.message));
  };
  useEffect(() => {
    if (!active) return;
    load.current();
    const t = setInterval(() => load.current(), POLL_MS);
    const vis = () => !document.hidden && load.current();
    document.addEventListener("visibilitychange", vis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [active]);

  const save = (p: BoardPrefs) => {
    store.set(KEY, JSON.stringify(p));
    return p;
  };

  const tasks = data?.tasks ?? [];
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [data]);
  const arranged = prefs.order !== null;
  const order = useMemo(() => (data ? mergeOrder(prefs.order ?? shown.current, tasks, arranged) : [STREAM_TILE]), [data, prefs.order]);

  // Remember what was shown; once arranged, keep the saved order in step (new tasks placed, removed ones gone).
  useEffect(() => {
    if (!data) return;
    shown.current = order;
    const ids = [STREAM_TILE, ...tasks.map((t) => t.id)];
    const collapsed = pruneCollapsed(prefs.collapsed, ids);
    const orderChanged = arranged && !sameOrder(prefs.order, order);
    if (orderChanged || collapsed.length !== prefs.collapsed.length) setPrefs(save({ order: arranged ? order : null, collapsed }));
  }, [order]);

  const nameOf = (id: string) => (id === STREAM_TILE ? "Stream" : byId.get(id)?.title || "Task");

  // ---- moving cards, with a FLIP glide so the eye can follow where each card went
  const cells = useRef(new Map<string, HTMLDivElement>());
  const before = useRef<Map<string, DOMRect> | null>(null);
  const capture = () => (before.current = new Map([...cells.current].map(([id, el]) => [id, el.getBoundingClientRect()])));

  const commit = (next: string[], id: string, captured = false) => {
    if (next === order) return;
    if (!captured) capture();
    setPrefs((p) => save({ ...p, order: next }));
    announce(movedMessage(nameOf(id), next.indexOf(id), next.length));
  };

  useLayoutEffect(() => {
    const prev = before.current;
    before.current = null;
    if (!prev || reduced) return;
    const moved: HTMLDivElement[] = [];
    for (const [id, el] of cells.current) {
      const a = prev.get(id);
      if (!a) continue;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      moved.push(el);
    }
    if (!moved.length) return;
    requestAnimationFrame(() => {
      for (const el of moved) {
        el.style.transition = "transform 0.42s var(--ease)";
        el.style.transform = "";
        el.addEventListener("transitionend", () => (el.style.transition = ""), { once: true });
      }
    });
  }, [order]);

  const toggle = (id: string) => setPrefs((p) => save({ ...p, collapsed: toggleCollapsed(p.collapsed, id) }));

  // ---- masonry: each card spans as many 4px rows as it is tall, so short cards don't leave holes
  const ro = useMemo(
    () =>
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            for (const e of entries) {
              const cell = (e.target as HTMLElement).parentElement;
              if (cell) cell.style.gridRowEnd = `span ${Math.ceil(((e.target as HTMLElement).offsetHeight + GAP) / ROW)}`;
            }
          }),
    [],
  );
  useEffect(() => () => ro?.disconnect(), []);
  // One stable ref per card, so cards aren't re-observed on every render.
  const refFns = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  const cellRef = (id: string) => {
    let fn = refFns.current.get(id);
    if (!fn) {
      fn = (el) => {
        const old = cells.current.get(id);
        if (old && old !== el && old.firstElementChild) ro?.unobserve(old.firstElementChild);
        if (el) {
          cells.current.set(id, el);
          if (el.firstElementChild) ro?.observe(el.firstElementChild);
        } else {
          cells.current.delete(id);
          refFns.current.delete(id);
        }
      };
      refFns.current.set(id, fn);
    }
    return fn;
  };

  // ---- drag and drop from the handle (pointer events: mouse, pen and touch alike)
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; pid: number; x: number; y: number; px: number; py: number; scroll: number; max: number; on: boolean; target: string | null; raf: number } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);

  const place = () => {
    const d = drag.current;
    const el = d && cells.current.get(d.id);
    if (!d || !el) return;
    const sc = scroller.current?.scrollTop ?? 0;
    el.style.transform = `translate(${d.px - d.x}px, ${d.py - d.y + sc - d.scroll}px)`;
    const boxes = [...cells.current]
      .filter(([id]) => id !== d.id)
      .map(([id, c]) => {
        const r = c.firstElementChild!.getBoundingClientRect();
        return { id, left: r.left, top: r.top, width: r.width, height: r.height };
      });
    const t = dropTarget(boxes, d.px, d.py);
    if (t !== d.target) setTarget((d.target = t));
  };

  // Near the top or bottom edge, the Board scrolls by itself so a card can travel the whole way.
  const edgeScroll = () => {
    const d = drag.current;
    const sc = scroller.current;
    if (!d || !sc) return;
    const r = sc.getBoundingClientRect();
    const edge = 56;
    const v = d.py < r.top + edge ? -(r.top + edge - d.py) / 4 : d.py > r.bottom - edge ? (d.py - (r.bottom - edge)) / 4 : 0;
    // Clamped to the height before the drag, so a card dragged past the end can't grow the page forever.
    const top = Math.min(d.max, Math.max(0, sc.scrollTop + Math.max(-14, Math.min(14, v))));
    if (v && Math.abs(top - sc.scrollTop) >= 1) {
      sc.scrollTop = top;
      place();
    }
    d.raf = requestAnimationFrame(edgeScroll);
  };

  const endDrag = (drop: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    cancelAnimationFrame(d.raf);
    const el = cells.current.get(d.id);
    setDragging(null);
    setTarget(null);
    if (!d.on || !el) return;
    const next = drop && d.target ? moveTo(order, d.id, order.indexOf(d.target)) : order;
    if (next !== order) {
      capture(); // from where it was dropped, glide into its new place
      el.style.transform = "";
      commit(next, d.id, true);
    } else {
      el.style.transition = reduced ? "" : "transform 0.3s var(--ease)";
      el.style.transform = "";
      if (!reduced) el.addEventListener("transitionend", () => (el.style.transition = ""), { once: true });
    }
  };

  const handle = (id: string) => ({
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { id, pid: e.pointerId, x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY, scroll: scroller.current?.scrollTop ?? 0, max: scroller.current ? scroller.current.scrollHeight - scroller.current.clientHeight : 0, on: false, target: null, raf: 0 };
    },
    onPointerMove: (e: PointerEvent) => {
      const d = drag.current;
      if (!d || d.pid !== e.pointerId) return;
      d.px = e.clientX;
      d.py = e.clientY;
      if (!d.on) {
        if (gesture(true, e.pointerType === "touch", e.clientX - d.x, e.clientY - d.y) !== "drag") return;
        d.on = true;
        setDragging(id);
        const el = cells.current.get(id);
        if (el) el.style.transition = "none";
        d.raf = requestAnimationFrame(edgeScroll);
      }
      place();
    },
    onPointerUp: (e: PointerEvent) => drag.current?.pid === e.pointerId && endDrag(true),
    onPointerCancel: (e: PointerEvent) => drag.current?.pid === e.pointerId && endDrag(false),
  });

  // Esc puts a dragged card back, before anything else hears the key.
  useEffect(() => {
    if (!dragging) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      endDrag(false);
    };
    addEventListener("keydown", on, true);
    return () => removeEventListener("keydown", on, true);
  }, [dragging]);
  useEffect(() => () => endDrag(false), []);

  // ---- sending
  const sendToTask = (id: string) => (text: string) => api.prompt(id, text).then(() => (load.current(), onChanged()));

  const empty = !!data && tasks.length === 0;
  const now = Date.now();

  return (
    <div class={`board scroll ${dragging ? "is-dragging" : ""}`} ref={scroller}>
      <div class="board-inner">
        {empty && <p class="board-empty">Results from your tasks will appear here.</p>}
        {loadError && !data && <div class="notice error">Couldn't load the Board: {loadError}. Trying again…</div>}
        <div class={`tiles ${ro ? "" : "plain"}`}>
          {order.map((id, i) => {
            const common = {
              id,
              index: i,
              total: order.length,
              collapsed: prefs.collapsed.includes(id),
              dragging: dragging === id,
              target: target === id && dragging !== id,
              cellRef: cellRef(id),
              handle: handle(id),
              onMove: (delta: number) => commit(moveBy(order, id, delta), id),
              onToggle: () => toggle(id),
            };
            if (id === STREAM_TILE)
              return (
                <Tile key={id} {...common} title="Stream" kind="stream" onOpen={onOpenStream}>
                  <StreamBody main={data?.main ?? null} loaded={!!data} onOpenStream={onOpenStream} onSent={() => (load.current(), onChanged())} announce={announce} />
                </Tile>
              );
            const t = byId.get(id);
            if (!t) return null;
            return (
              <Tile key={id} {...common} title={t.title || "Task"} kind="task" status={t.status} onOpen={() => onOpenTask(id)}>
                <TaskBody task={t} now={now} onOpen={() => onOpenTask(id)} onCommand={sendToTask(id)} />
              </Tile>
            );
          })}
        </div>
        {data && order.length > 1 && (
          <p class="muted small board-hint">To arrange, drag a card by its dotted handle, or use its arrow buttons.</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- one card
function Tile({
  id,
  title,
  kind,
  status,
  index,
  total,
  collapsed,
  dragging,
  target,
  cellRef,
  handle,
  onMove,
  onToggle,
  onOpen,
  children,
}: {
  id: string;
  title: string;
  kind: "stream" | "task";
  status?: Task["status"];
  index: number;
  total: number;
  collapsed: boolean;
  dragging: boolean;
  target: boolean;
  cellRef(el: HTMLDivElement | null): void;
  handle: Record<string, (e: PointerEvent) => void>;
  onMove(delta: number): void;
  onToggle(): void;
  onOpen(): void;
  children: ComponentChildren;
}) {
  const tid = `tile-${id}-t`;
  const bid = `tile-${id}-b`;
  const first = index === 0;
  const last = index === total - 1;
  return (
    <div ref={cellRef} class={`tile-cell ${dragging ? "dragging" : ""} ${target ? "drop-here" : ""}`}>
      <article class={`tile t-${kind} ${status ? `s-${status}` : ""} ${collapsed ? "collapsed" : ""}`} aria-labelledby={tid}>
        <header class="tile-bar">
          <span class="tile-grip" data-noswipe aria-hidden="true" title="Drag to move" {...handle}>
            <IconGrip />
          </span>
          <div class="tile-name">
            <h3 id={tid}>
              <button type="button" class="tile-title" onClick={onOpen}>{title}</button>
            </h3>
            {status && <StatusChip status={status} />}
          </div>
          <div class="tile-tools">
            <button type="button" class="icon-btn" aria-label="Move earlier" aria-describedby={tid} title="Move earlier" aria-disabled={first} onClick={() => !first && onMove(-1)}>
              <IconEarlier />
            </button>
            <button type="button" class="icon-btn" aria-label="Move later" aria-describedby={tid} title="Move later" aria-disabled={last} onClick={() => !last && onMove(1)}>
              <IconLater />
            </button>
            <button type="button" class="icon-btn fold" aria-label={collapsed ? "Expand" : "Collapse"} aria-describedby={tid} title={collapsed ? "Expand" : "Collapse"} aria-expanded={!collapsed} aria-controls={bid} onClick={onToggle}>
              <IconFold />
            </button>
          </div>
        </header>
        <div class="tile-body" id={bid} hidden={collapsed}>
          {children}
        </div>
      </article>
    </div>
  );
}

// ---------------------------------------------------------------- the Stream's card
function StreamBody({
  main,
  loaded,
  onOpenStream,
  onSent,
  announce,
}: {
  main: BoardState["main"] | null;
  loaded: boolean;
  onOpenStream(): void;
  onSent(): void;
  announce(msg: string): void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  const submit = async (e: Event) => {
    e.preventDefault();
    const msg = text.trim();
    if (!msg || busy || !main) return;
    setBusy(true);
    setError("");
    try {
      await api.prompt(main.id, msg);
      setText("");
      setSent(true);
      announce("Sent to the Stream");
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setSent(false), 4000);
      onSent();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const you = main?.lastUser.trim() ?? "";
  const answer = main?.lastAssistant.trim() ?? "";
  return (
    <>
      {!loaded ? (
        <p class="muted small">Loading…</p>
      ) : you || answer ? (
        <div class="tile-weave">
          {you && <p class="tw-you">{clip(you, 160)}</p>}
          {answer && (
            <div class={`tw-ai ${answer.length > 320 ? "long" : ""}`}>
              <Markdown text={clip(answer, 360)} />
            </div>
          )}
        </div>
      ) : (
        <p class="muted small">Nothing in the Stream yet. Say hello below.</p>
      )}
      <form class="tile-send" onSubmit={submit}>
        <input aria-label="Write to the Stream" placeholder="Write to the Stream…" autocomplete="off" value={text} onInput={(e) => setText(e.currentTarget.value)} />
        <button class="btn primary" type="submit" disabled={!text.trim() || busy || !main}>Send</button>
      </form>
      {error && <div class="notice error small">Couldn't send that: {error}</div>}
      <div class="tile-foot">
        {sent ? <span class="tone-success small">Sent to the Stream.</span> : <span />}
        <button type="button" class="btn small-btn" onClick={onOpenStream}>Open the Stream <IconArrow /></button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- a task's card
function TaskBody({ task, now, onOpen, onCommand }: { task: Task; now: number; onOpen(): void; onCommand(text: string): Promise<unknown> }) {
  const [error, setError] = useState("");
  const { panels, skipped } = useMemo(() => validPanels(task.panels), [task.panels]);
  const needs = task.status === "needs_you";
  const open = needs || task.status === "working";
  const preview = plainPreview(task.preview);
  const line = needs ? "It's waiting for your answer." : task.status === "working" ? preview || "Getting started…" : preview;

  const command = (text: string) => {
    setError("");
    onCommand(text).catch((e: Error) => setError(e.message));
  };

  return (
    <>
      {open && (
        <span class="weft" aria-hidden="true"><span class="shuttle" /></span>
      )}
      {line && <p class="tile-line">{line}</p>}
      {panels.length > 0 && (
        <div class="tile-results">
          {panels.map((p) => <PanelView key={p.id} panel={p} onCommand={command} />)}
        </div>
      )}
      {skipped > 0 && <p class="muted small">{skippedLabel(skipped)}</p>}
      {error && (
        <div class="notice error small tile-error">
          Couldn't send that to the task: {error} <button type="button" class="link" onClick={() => setError("")}>dismiss</button>
        </div>
      )}
      <div class="tile-foot">
        <span class="muted small tile-when">{ago(task.updated_at, now)}</span>
        <button type="button" class={`btn small-btn ${needs ? "needs" : ""}`} onClick={onOpen}>
          {needs ? "Needs your OK · Open" : "Open"} <IconArrow />
        </button>
      </div>
    </>
  );
}
