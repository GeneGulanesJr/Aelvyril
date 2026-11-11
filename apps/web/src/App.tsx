import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, ApiError, type ThreadRow } from "./api.ts";
import { Settings } from "./Settings.tsx";
import { useThread } from "./Thread.tsx";
import { Stream } from "./Stream.tsx";
import { Inbox } from "./Inbox.tsx";
import { Quick } from "./Quick.tsx";
import { Board } from "./Board.tsx";
import { store } from "./store.ts";
import { TaskView } from "./Task.tsx";
import { IconArrow, IconBoard, IconInbox, IconQuick, IconSettings, IconStream } from "./icons.tsx";
import {
  announcements,
  dragOffset,
  isUnlocked,
  isView,
  neighbour,
  swipeAxis,
  swipeResult,
  VIEWS,
  waitingOnYou,
  type Axis,
  type ViewId,
} from "./model.ts";

type Auth = "loading" | "signed-out" | "signed-in";

export function App() {
  const [auth, setAuth] = useState<Auth>("loading");
  const [setup, setSetup] = useState({ needsSetup: false, needsCode: false });

  const check = useCallback(async () => {
    try {
      await api.threads();
      setAuth("signed-in");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setSetup(await api.setup());
        setAuth("signed-out");
      } else throw e;
    }
  }, []);
  useEffect(() => void check(), []);

  if (auth === "loading") return <div class="center muted">Loading…</div>;
  if (auth === "signed-out") return <Login setup={setup} onDone={check} />;
  return <Shell onSignOut={() => api.signOut().then(check)} />;
}

function Login({ setup, onDone }: { setup: { needsSetup: boolean; needsCode: boolean }; onDone(): void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: Event) => {
    e.preventDefault();
    setErr("");
    try {
      if (setup.needsSetup) await api.signUp(email, password, name || "Owner", code);
      else await api.signIn(email, password);
      onDone();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  };
  return (
    <div class="gate">
      <div class="gate-cloth" aria-hidden="true" />
      <div class="gate-form">
        <form class="login" onSubmit={submit}>
          <h1>Aelvyril</h1>
          <p class="muted lede">{setup.needsSetup ? "Welcome! Create your account to get started. It stays on this computer." : "Sign in to continue."}</p>
          {setup.needsSetup && <input placeholder="Your name" value={name} onInput={(e) => setName(e.currentTarget.value)} />}
          <input type="email" required placeholder="Email" autocomplete="username" value={email} onInput={(e) => setEmail(e.currentTarget.value)} />
          <input type="password" required minLength={8} placeholder={setup.needsSetup ? "Password (at least 8 characters)" : "Password"} autocomplete={setup.needsSetup ? "new-password" : "current-password"} value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
          {setup.needsSetup && setup.needsCode && (
            <label class="field">
              <input required placeholder="Setup code" value={code} onInput={(e) => setCode(e.currentTarget.value)} />
              <span class="muted small">You'll find the code in the program's log. In Docker Desktop: Containers → aelvyril → Logs.</span>
            </label>
          )}
          {err && <div class="notice error">{err}</div>}
          <button class="btn primary" type="submit">{setup.needsSetup ? "Create account" : "Sign in"}</button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- small helpers
function useMedia(q: string) {
  const [m, setM] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

const readHash = () => /^#\/task\/([\w-]+)$/.exec(location.hash)?.[1] ?? null;
const viewIndex = (v: ViewId) => VIEWS.findIndex((x) => x.id === v);

/** A swipe must not start where something scrolls sideways or takes typing. */
function blocksSwipe(target: Element | null, root: Element) {
  for (let el = target; el && el !== root; el = el.parentElement) {
    if (el.matches("textarea, input, select, pre, code, table, [data-noswipe]")) return true;
    const ox = getComputedStyle(el).overflowX;
    if ((ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 1) return true;
  }
  return false;
}

/** Tab stays inside an open overlay. */
function trapTab(e: KeyboardEvent, box: HTMLElement | null) {
  if (e.key !== "Tab" || !box) return;
  const f = [...box.querySelectorAll<HTMLElement>("button:not([disabled]), input, textarea, select, a[href]")];
  if (!f.length) return;
  const [first, last] = [f[0], f[f.length - 1]];
  if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
  else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
}

// ---------------------------------------------------------------- the shell
function Shell({ onSignOut }: { onSignOut(): void }) {
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [mainId, setMainId] = useState<string | null>(null);
  const [hasAI, setHasAI] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<null | "models" | "extensions">(null);
  const [remembered, setRemembered] = useState(() => store.get("aelvyril.unlocked") === "1");
  const [view, setView] = useState<ViewId>(() => {
    const v = store.get("aelvyril.view");
    return isView(v) ? v : "stream";
  });
  const [anim, setAnim] = useState<{ from: ViewId; dir: 1 | -1 } | null>(null);
  const [taskId, setTaskId] = useState<string | null>(readHash);
  const [overlay, setOverlay] = useState(false);
  const [draft, setDraft] = useState("");
  const [said, setSaid] = useState("");
  const phone = useMedia("(max-width: 720px)");
  const reduced = useMedia("(prefers-reduced-motion: reduce)");

  const prevList = useRef<ThreadRow[] | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const streamInput = useRef<HTMLTextAreaElement>(null);
  const viewsRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const overlayOpener = useRef<HTMLElement | null>(null);

  const unlocked = isUnlocked(threads, remembered);
  const current: ViewId = unlocked ? view : "stream";
  const rows = useMemo(() => new Map(threads.map((t) => [t.id, t])), [threads]);
  const waiting = waitingOnYou(threads);
  // The strip names what's waiting that isn't already open on screen.
  const strip = waiting.filter((t) => t.id !== taskId);
  const anyWorking = threads.some((t) => t.kind === "job" && t.status === "working");

  const announce = (msg: string) => {
    setSaid("");
    requestAnimationFrame(() => setSaid(msg));
  };

  const refresh = useCallback(
    () =>
      api
        .threads()
        .then((list) => {
          const msgs = announcements(prevList.current, list);
          prevList.current = list;
          setThreads(list);
          if (msgs.length) announce(msgs.join(". "));
        })
        .catch(() => {}),
    [],
  );
  const checkAI = useCallback(() => api.providers().then((s) => setHasAI(s.providers.some((p) => p.configured))).catch(() => {}), []);

  useEffect(() => {
    api.main().then((m) => setMainId(m.id)).catch(() => {});
    refresh();
    checkAI();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, []);

  // Once a task has finished, the switcher stays, even if tasks are deleted later.
  useEffect(() => {
    if (unlocked && !remembered) {
      store.set("aelvyril.unlocked", "1");
      setRemembered(true);
    }
  }, [unlocked]);

  useEffect(() => {
    document.title = waiting.length ? `(${waiting.length}) Aelvyril` : "Aelvyril";
  }, [waiting.length]);

  const stream = useThread(mainId, 400, refresh);

  // ---- opening and closing a task (lives in the address, so the phone's Back closes it)
  useEffect(() => {
    const on = () => setTaskId(readHash());
    addEventListener("popstate", on);
    addEventListener("hashchange", on);
    return () => {
      removeEventListener("popstate", on);
      removeEventListener("hashchange", on);
    };
  }, []);

  const inboxPane = current === "inbox" && !phone;
  const openTask = (id: string) => {
    opener.current = document.activeElement as HTMLElement | null;
    setOverlay(false);
    setSettings(null);
    if (inboxPane || (taskId && !phone)) history.replaceState(history.state, "", `#/task/${id}`);
    else history.pushState({ aelvTask: id }, "", `#/task/${id}`);
    setTaskId(id);
  };
  const closeTask = (restoreFocus = true) => {
    if (history.state?.aelvTask) history.back();
    else {
      history.replaceState(null, "", location.pathname + location.search);
      setTaskId(null);
    }
    if (restoreFocus) setTimeout(() => opener.current?.isConnected && opener.current.focus(), 0);
  };

  // ---- switching views
  const switchTo = (v: ViewId, animate = true) => {
    setSettings(null);
    if (v === current) return;
    if (animate && !reduced) {
      setAnim({ from: current, dir: viewIndex(v) > viewIndex(current) ? 1 : -1 });
      setTimeout(() => setAnim(null), 340);
    } else setAnim(null);
    setView(v);
    store.set("aelvyril.view", v);
    // A task chosen in the Inbox shouldn't pop open as a panel over the Stream.
    if (current === "inbox" && taskId && !phone) {
      history.replaceState(null, "", location.pathname + location.search);
      setTaskId(null);
    }
  };

  // ---- keyboard: Ctrl/Cmd+K opens Quick anywhere, Esc closes the top layer.
  // Registered once and reading the latest state through a ref: re-registering after every render left a gap
  // (effects run a moment after the screen updates) in which a key pressed right after a change was ignored.
  const latest = useRef({ unlocked, overlay, taskId, inboxPane, phone, settings, closeTask });
  latest.current = { unlocked, overlay, taskId, inboxPane, phone, settings, closeTask };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const s = latest.current;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && s.unlocked) {
        e.preventDefault();
        if (!s.overlay) overlayOpener.current = document.activeElement as HTMLElement | null;
        setOverlay((o) => !o);
      } else if (e.key === "Escape") {
        if (s.overlay) setOverlay(false);
        else if (s.taskId && !s.inboxPane && !s.phone && !s.settings) s.closeTask();
      }
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, []);
  useEffect(() => {
    if (!overlay) overlayOpener.current?.isConnected && overlayOpener.current.focus();
  }, [overlay]);

  // ---- touch: swipe sideways on the content to move between views
  const drag = useRef<{ id: number; x: number; y: number; t: number; axis: Axis; dx: number; nb: ViewId | null } | null>(null);
  const viewEl = (v: ViewId | null) => (v ? viewsRef.current?.querySelector<HTMLElement>(`[data-view="${v}"]`) ?? null : null);
  const clearDrag = () => {
    viewsRef.current?.querySelectorAll<HTMLElement>("[data-view]").forEach((el) => {
      el.style.transform = "";
      el.style.transition = "";
      el.classList.remove("peek");
    });
  };
  const swipeOn = unlocked && !overlay && !settings && !(phone && taskId);
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || !swipeOn || !viewsRef.current) return;
    if (blocksSwipe(e.target as Element, viewsRef.current)) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), axis: "pending", dx: 0, nb: null };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    if (d.axis === "pending") {
      d.axis = swipeAxis(dx, e.clientY - d.y);
      if (d.axis === "y") return void (drag.current = null);
      if (d.axis === "pending") return;
      viewsRef.current?.setPointerCapture(e.pointerId);
    }
    d.dx = dx;
    const prev = neighbour(current, -1);
    const next = neighbour(current, 1);
    const off = dragOffset(dx, !!prev, !!next);
    const nb = dx < 0 ? next : prev;
    if (d.nb !== nb) {
      clearDrag();
      d.nb = nb;
    }
    const el = viewEl(current);
    if (el) (el.style.transition = "none"), (el.style.transform = `translateX(${off}px)`);
    const n = viewEl(nb);
    if (n) {
      n.classList.add("peek");
      n.style.transition = "none";
      n.style.transform = `translateX(calc(${off}px ${dx < 0 ? "+" : "-"} 100%))`;
    }
  };
  const onPointerEnd = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId || d.axis !== "x") return;
    const width = viewsRef.current?.clientWidth ?? 1;
    const res = e.type === "pointercancel" ? 0 : swipeResult(d.dx, width, performance.now() - d.t, !!neighbour(current, -1), !!neighbour(current, 1));
    const el = viewEl(current);
    const n = viewEl(d.nb);
    const ms = reduced ? 0 : 260;
    for (const x of [el, n]) if (x) x.style.transition = `transform ${ms}ms cubic-bezier(0.16, 1, 0.3, 1)`;
    if (res && d.nb && n && el) {
      el.style.transform = `translateX(${res > 0 ? "-" : ""}100%)`;
      n.style.transform = "translateX(0)";
      const target = d.nb;
      setTimeout(() => {
        clearDrag();
        switchTo(target, false);
      }, ms);
    } else {
      if (el) el.style.transform = "translateX(0)";
      if (n) n.style.transform = `translateX(${d.dx < 0 ? "" : "-"}100%)`;
      setTimeout(clearDrag, ms);
    }
  };

  const submitQuick = async (text: string) => {
    if (!mainId) throw new Error("The Stream isn't ready yet. Try again in a moment.");
    await api.prompt(mainId, text);
    setOverlay(false);
    if (taskId && !phone) closeTask(false);
    switchTo("stream");
    refresh();
    return true;
  };

  const openSettings = (tab: "models" | "extensions" = "models") => setSettings(tab);
  const sheetOpen = !!taskId && !inboxPane && !settings;
  const viewLabel = VIEWS.find((v) => v.id === current)?.label ?? "Stream";
  const available = unlocked ? VIEWS : VIEWS.filter((v) => v.id === "stream");

  const renderView = (id: ViewId) => {
    const active = id === current && !settings;
    if (id === "stream")
      return (
        <Stream
          mainId={mainId}
          t={stream.t}
          live={stream.live}
          loaded={stream.loaded}
          rows={rows}
          hasAI={hasAI}
          draft={draft}
          setDraft={setDraft}
          inputRef={streamInput}
          anyWorking={anyWorking}
          onOpenTask={openTask}
          onOpenSettings={() => openSettings()}
          onChanged={refresh}
        />
      );
    if (id === "inbox") return <Inbox threads={threads} rows={rows} selected={taskId} phone={phone} onSelect={openTask} onChanged={refresh} />;
    if (id === "board")
      return <Board active={active && !(phone && !!taskId)} reduced={reduced} onOpenTask={openTask} onOpenStream={() => switchTo("stream")} onChanged={refresh} announce={announce} />;
    return <Quick threads={threads} active={active && !overlay} onSubmit={submitQuick} onOpenTask={openTask} />;
  };

  return (
    <div class={`shell ${sheetOpen && !phone ? "shift" : ""} ${unlocked ? "has-tabs" : ""}`}>
      <header class={`beam ${unlocked ? "has-tabs" : ""}`}>
        <div class="brand"><span class="label-mark">Aelvyril</span></div>
        {unlocked && <Switcher current={settings ? null : current} needs={waiting.length} onPick={switchTo} />}
        <button class={`icon-btn gear ${settings ? "on" : ""}`} aria-label="Settings" title="Settings" onClick={() => openSettings()}>
          <IconSettings />
          <span class="gear-label" aria-hidden="true">Settings</span>
        </button>
      </header>

      {strip.length > 0 && !settings && current !== "inbox" && (
        <div class="attention" role="region" aria-label="Waiting for you">
          <span class="knot k-needs_you" aria-hidden="true" />
          <button class="attention-main" onClick={() => openTask(strip[0].id)}>
            <span class="attention-text"><strong>{strip[0].title}</strong> needs your OK</span>
            <span class="attention-go">Open <IconArrow /></span>
          </button>
          {strip.length > 1 &&
            (unlocked ? (
              <button class="link attention-more" onClick={() => switchTo("inbox")}>+{strip.length - 1} more</button>
            ) : (
              <button class="link attention-more" onClick={() => openTask(strip[1].id)}>Next</button>
            ))}
        </div>
      )}

      <div
        ref={viewsRef}
        class="views"
        inert={!!settings || (phone && !!taskId) || overlay}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        {available.map((v) => {
          const on = v.id === current;
          const out = anim?.from === v.id;
          return (
            <div
              key={v.id}
              data-view={v.id}
              id={`view-${v.id}`}
              role={unlocked ? "tabpanel" : undefined}
              aria-labelledby={unlocked ? `tab-${v.id}` : undefined}
              class={`view ${on ? "on" : ""} ${on && anim ? "in" : ""} ${out ? "out" : ""}`}
              style={anim ? { "--dir": anim.dir } : undefined}
              inert={!on}
            >
              {renderView(v.id)}
            </div>
          );
        })}
      </div>

      {sheetOpen && taskId && (
        <aside class={`sheet ${phone ? "full" : "side"}`} aria-label={`Task: ${rows.get(taskId)?.title ?? ""}`}>
          <TaskView
            key={taskId}
            id={taskId}
            row={rows.get(taskId)}
            rows={rows}
            mode={phone ? "full" : "sheet"}
            backLabel={`Back to ${viewLabel}`}
            onClose={() => closeTask()}
            onChanged={refresh}
            onOpenTask={openTask}
          />
        </aside>
      )}

      {settings && (
        <div class="settings-layer">
          <Settings initialTab={settings} onBack={() => { setSettings(null); checkAI(); }} onSignOut={onSignOut} />
        </div>
      )}

      {overlay && (
        <div class="modal-back quick-back" onClick={(e) => e.target === e.currentTarget && setOverlay(false)}>
          <div ref={overlayRef} class="modal quick-modal" role="dialog" aria-modal="true" aria-label="Quick" onKeyDown={(e) => trapTab(e, overlayRef.current)}>
            <Quick overlay active threads={threads} onSubmit={submitQuick} onOpenTask={openTask} />
            <p class="muted small quick-esc"><kbd>Esc</kbd> to close</p>
          </div>
        </div>
      )}

      <div class="sr-only" role="status" aria-live="polite">{said}</div>
    </div>
  );
}

const VIEW_ICON: Record<ViewId, () => preact.JSX.Element> = { stream: IconStream, inbox: IconInbox, quick: IconQuick, board: IconBoard };

/** Stream, Inbox, Quick, Board (read from VIEWS): a side menu on wide screens, a bottom bar on phones.
    A real tablist; the oat shuttle slides to the chosen view. */
function Switcher({ current, needs, onPick }: { current: ViewId | null; needs: number; onPick(v: ViewId): void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const idx = current ? viewIndex(current) : -1;
  const n = VIEWS.length;
  const onKey = (e: KeyboardEvent, i: number) => {
    const j = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % n : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    refs.current[j]?.focus();
    onPick(VIEWS[j].id);
  };
  return (
    <div class={`switcher ${idx < 0 ? "none" : ""}`} role="tablist" aria-label="Views" style={{ "--i": Math.max(idx, 0), "--n": n }}>
      <span class="shuttle-tab" aria-hidden="true" />
      {VIEWS.map((v, i) => (
        <button
          ref={(el) => void (refs.current[i] = el)}
          role="tab"
          id={`tab-${v.id}`}
          aria-selected={i === idx}
          aria-controls={`view-${v.id}`}
          aria-describedby={v.id === "inbox" && needs > 0 ? "inbox-needs" : undefined}
          tabIndex={i === Math.max(idx, 0) ? 0 : -1}
          onClick={() => onPick(v.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {VIEW_ICON[v.id]()}
          {v.label}
          {v.id === "inbox" && needs > 0 && <span class="badge" aria-hidden="true">{needs}</span>}
        </button>
      ))}
      <span id="inbox-needs" class="sr-only">{needs === 1 ? "1 task needs you" : `${needs} tasks need you`}</span>
    </div>
  );
}
