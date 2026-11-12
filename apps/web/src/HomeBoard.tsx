// The home screen as a grid of tiles (the assistant, the chat box, each widget). Drag a tile by the bar on its top edge
// (or anywhere on it with a mouse, where that can't be mistaken for selecting text) and it snaps to the grid; whatever it
// would cover moves down, so nothing overlaps. Drag the bottom-right corner to resize. Saved with the look (design.layout).
import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import { arrange, GRID_COLS, settle, type Layout, type Tile } from "./model.ts";

export interface BoardItem {
  id: string;
  /** For "Move …" on its handle. */
  label: string;
  w: number;
  h: number;
  minW: number;
  minH: number;
  /** Its spot before the person moves it, if it has a preferred one. */
  x?: number;
  y?: number;
  /** A mouse can grab it anywhere, not only by the bar. */
  grabAnywhere?: boolean;
  node: ComponentChildren;
}

const toLayout = (t: Tile[]): Layout => Object.fromEntries(t.map(({ id, ...r }) => [id, r]));
const same = (a: Tile[], b: Tile[]) => a.every((t, i) => t.x === b[i].x && t.y === b[i].y && t.w === b[i].w && t.h === b[i].h);
const STEP: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

export function HomeBoard({ items, saved, onSave }: { items: BoardItem[]; saved: Layout; onSave(l: Layout): void }) {
  const [preview, setPreview] = useState<Tile[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const tiles = preview ?? arrange(items, saved);

  /** One grid step in pixels, across and down. */
  const pitch = () => {
    const b = ref.current!;
    const cs = getComputedStyle(b);
    const gx = parseFloat(cs.columnGap) || 0;
    return { x: (b.clientWidth - gx * (GRID_COLS - 1)) / GRID_COLS + gx, y: (parseFloat(cs.gridAutoRows) || 44) + (parseFloat(cs.rowGap) || 0) };
  };
  const resized = (t: Tile, item: BoardItem, dw: number, dh: number) => ({ ...t, w: Math.max(item.minW, t.w + dw), h: Math.max(item.minH, t.h + dh) });

  const begin = (e: PointerEvent, item: BoardItem, mode: "move" | "size") => {
    const target = e.target as HTMLElement;
    const handle = mode === "size" || !!target.closest(".tile-grip");
    if (e.button !== 0 || matchMedia("(max-width: 700px)").matches) return; // on a phone the tiles are one column
    if (!handle && (!item.grabAnywhere || e.pointerType !== "mouse" || target.closest("button, a, input, select, textarea, summary, [contenteditable]"))) return;
    if (handle) e.preventDefault(), e.stopPropagation();
    const start = tiles;
    const t0 = start.find((t) => t.id === item.id)!;
    const p = pitch();
    const x0 = e.clientX, y0 = e.clientY;
    let on = false, cur = start;
    // Listened for on the window: the tile moves in the page while dragged, so it can't hold on to the pointer itself.
    const move = (ev: PointerEvent) => {
      const dx = Math.round((ev.clientX - x0) / p.x), dy = Math.round((ev.clientY - y0) / p.y);
      if (!on) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
        on = true;
        setActive(item.id);
        document.documentElement.classList.add("moving-tile");
        getSelection()?.removeAllRanges();
      }
      const c = mode === "move" ? { ...t0, x: t0.x + dx, y: t0.y + dy } : resized(t0, item, dx, dy);
      const next = settle(start.map((t) => (t.id === item.id ? c : t)), item.id);
      if (!same(next, cur)) setPreview((cur = next));
    };
    const drop = (ev: PointerEvent) => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", drop);
      removeEventListener("pointercancel", drop);
      if (!on) return;
      document.documentElement.classList.remove("moving-tile");
      setActive(null);
      if (ev.type === "pointerup") onSave(toLayout(cur));
      setPreview(null);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", drop);
    addEventListener("pointercancel", drop);
  };

  // Keyboard on the handle: arrows move a step, Shift+arrows resize.
  const onKey = (e: KeyboardEvent, item: BoardItem) => {
    const d = STEP[e.key];
    if (!d) return;
    e.preventDefault();
    const t0 = tiles.find((t) => t.id === item.id)!;
    const c = e.shiftKey ? resized(t0, item, d[0], d[1]) : { ...t0, x: t0.x + d[0], y: t0.y + d[1] };
    onSave(toLayout(settle(tiles.map((t) => (t.id === item.id ? c : t)), item.id)));
  };

  return (
    <div ref={ref} class={`home-board ${active ? "arranging" : ""}`}>
      {items.map((it) => {
        const t = tiles.find((x) => x.id === it.id)!;
        return (
          <div
            key={it.id}
            data-tile={it.id}
            class={`tile ${active === it.id ? "moving" : ""} ${it.grabAnywhere ? "grab" : ""}`}
            style={{ gridColumn: `${t.x + 1} / span ${t.w}`, gridRow: `${t.y + 1} / span ${t.h}`, order: t.y * GRID_COLS + t.x }}
            onPointerDown={(e) => begin(e, it, "move")}
          >
            <button class="tile-grip" aria-label={`Move ${it.label}`} aria-describedby="board-help" title="Drag to move · arrow keys move · Shift+arrow keys resize" onKeyDown={(e) => onKey(e, it)} />
            <div class="tile-body">{it.node}</div>
            <span class="tile-size" aria-hidden="true" title="Drag to resize" onPointerDown={(e) => begin(e, it, "size")} />
          </div>
        );
      })}
      <span id="board-help" class="sr-only">Arrow keys move it on the home screen; Shift and the arrow keys change its size.</span>
    </div>
  );
}
