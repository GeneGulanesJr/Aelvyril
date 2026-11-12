import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, ApiError, type ThreadRow, type WidgetRow } from "./api.ts";
import { Settings } from "./Settings.tsx";
import { TaskChips, useThread } from "./Thread.tsx";
import { Stream } from "./Stream.tsx";
import { Inbox } from "./Inbox.tsx";
import { Quick } from "./Quick.tsx";
import { Mascot, type Mood } from "./Mascot.tsx";
import { Markdown, PanelView } from "./Panel.tsx";
import type { Item } from "./transcript.ts";
import { store } from "./store.ts";
import { applyDesign, type Design } from "./design.ts";
import { HomeBoard, type BoardItem } from "./HomeBoard.tsx";
import { PreviewModal, ProjectCard, useProjects } from "./Projects.tsx";
import type { ProjectRow } from "./api.ts";
import { readScreen } from "./screen.ts";
import { TaskView } from "./Task.tsx";
import { IconArrow, IconClose, IconHome, IconInbox, IconSettings, IconStream } from "./icons.tsx";
import {
  ago,
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
  type Layout,
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
  const [settings, setSettings] = useState<null | "models" | "extensions" | "github">(() => (new URLSearchParams(location.search).has("github") ? "github" : null));
  const [remembered, setRemembered] = useState(() => store.get("aelvyril.unlocked") === "1");
  const [view, setView] = useState<ViewId>(() => {
    const v = store.get("aelvyril.view");
    return isView(v) ? v : "stream";
  });
  const [anim, setAnim] = useState<{ from: ViewId; dir: 1 | -1 } | null>(null);
  const [taskId, setTaskId] = useState<string | null>(readHash);
  // People who have used the app before land on the home screen; a task link opens straight to the task.
  const [home, setHome] = useState(() => store.get("aelvyril.unlocked") === "1" && !readHash());
  const [overlay, setOverlay] = useState(false);
  const [draft, setDraft] = useState("");
  const [said, setSaid] = useState("");
  const [design, setDesign] = useState<Design>({});
  const widgets = useWidgets();
  const projects = useProjects();
  const [previewing, setPreviewing] = useState<ProjectRow | null>(null);
  const [assistantName, setAssistantName] = useState("Aelvyril"); // what the person called their assistant in Settings
  const phone = useMedia("(max-width: 720px)");
  // the tiles sit on the left and right edges only where the chat column fits between them (about 1180px and up)
  const narrow = useMedia("(max-width: 1179px)");
  const reduced = useMedia("(prefers-reduced-motion: reduce)");

  const prevList = useRef<ThreadRow[] | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const streamInput = useRef<HTMLTextAreaElement>(null);
  const viewsRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const overlayOpener = useRef<HTMLElement | null>(null);

  const unlocked = isUnlocked(threads, remembered);
  const current: ViewId = unlocked ? view : "stream";
  const atHome = unlocked && home; // the home screen is the one underneath; Settings can lie over it
  const onHome = atHome && !settings;
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

  // Tell the gateway how big this screen is (on load, when it changes, and every few minutes), so the assistant can design for it.
  useEffect(() => {
    let later = 0;
    const send = () => void api.reportScreen(readScreen()).catch(() => {});
    const soon = () => (clearTimeout(later), (later = window.setTimeout(send, 800)));
    send();
    const beat = setInterval(send, 5 * 60_000);
    const dark = matchMedia("(prefers-color-scheme: dark)");
    addEventListener("resize", soon);
    addEventListener("orientationchange", soon);
    document.addEventListener("visibilitychange", soon);
    dark.addEventListener("change", soon);
    return () => {
      clearTimeout(later);
      clearInterval(beat);
      removeEventListener("resize", soon);
      removeEventListener("orientationchange", soon);
      document.removeEventListener("visibilitychange", soon);
      dark.removeEventListener("change", soon);
    };
  }, []);

  const loadName = useCallback(() => api.profile().then((p) => setAssistantName(p.assistantName)).catch(() => {}), []);
  useEffect(() => void loadName(), []);

  // The look the person asked for in the chat: read it now and every few seconds (it only changes when they ask).
  useEffect(() => {
    let last = "";
    const pull = () =>
      api.design().then((d) => {
        const j = JSON.stringify(d);
        if (j !== last) (last = j), applyDesign(d), setDesign(d);
      }).catch(() => {});
    pull();
    const t = setInterval(pull, 4000);
    addEventListener("aelvyril-design", pull); // Settings' "Back to the original look" asks for an immediate re-read
    return () => (clearInterval(t), removeEventListener("aelvyril-design", pull));
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

  const openTask = (id: string) => {
    opener.current = document.activeElement as HTMLElement | null;
    setOverlay(false);
    setSettings(null);
    setHome(false);
    if (taskId && !phone) history.replaceState(history.state, "", `#/task/${id}`);
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
    const fromHome = home;
    setHome(false); // the screen itself slides in over the home screen, so no second slide inside it
    if (v === current) return;
    if (animate && !reduced && !fromHome) {
      setAnim({ from: current, dir: viewIndex(v) > viewIndex(current) ? 1 : -1 });
      setTimeout(() => setAnim(null), 340);
    } else setAnim(null);
    setView(v);
    store.set("aelvyril.view", v);
  };

  const goHome = () => {
    setSettings(null);
    setOverlay(false);
    setHome(true);
    if (taskId) {
      history.replaceState(null, "", location.pathname + location.search);
      setTaskId(null);
    }
  };

  // ---- keyboard: Ctrl/Cmd+K opens Quick anywhere, Esc closes the top layer.
  // Registered once and reading the latest state through a ref: re-registering after every render left a gap
  // (effects run a moment after the screen updates) in which a key pressed right after a change was ignored.
  const latest = useRef({ unlocked, overlay, taskId, phone, settings, closeTask, home, goHome });
  latest.current = { unlocked, overlay, taskId, phone, settings, closeTask, home, goHome };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const s = latest.current;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && s.unlocked) {
        e.preventDefault();
        if (!s.overlay) overlayOpener.current = document.activeElement as HTMLElement | null;
        setOverlay((o) => !o);
      } else if (e.key === "Escape") {
        if (s.overlay) setOverlay(false);
        else if (s.taskId && !s.phone && !s.settings) s.closeTask();
        else if (s.unlocked && !s.home && !s.settings && !(e.target as Element).closest?.("input, textarea, select")) s.goHome();
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

  // The chat box on the home screen: the answer shows right under the orb, so the person never has to leave home.
  const askFromHome = async (text: string) => {
    if (!mainId) throw new Error("The Stream isn't ready yet. Try again in a moment.");
    await api.prompt(mainId, text);
    refresh();
  };

  const openSettings = (tab: "models" | "extensions" = "models") => setSettings(tab);
  const sheetOpen = !!taskId && !settings;
  const viewLabel = VIEWS.find((v) => v.id === current)?.label ?? "Stream";
  const available = unlocked ? VIEWS : VIEWS.filter((v) => v.id === "stream");

  const renderView = (id: ViewId) => {
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
          assistantName={assistantName}
          onOpenTask={openTask}
          onOpenSettings={() => openSettings()}
          onChanged={refresh}
        />
      );
    if (id === "inbox") return <Inbox threads={threads} onOpenTask={openTask} />;
    return null;
  };

  // What's happening, as chips on the home screen: needs-you first, then what's working.
  const going = [...waiting, ...threads.filter((t) => t.kind === "job" && t.status === "working")];

  const mood: Mood = waiting.length ? "needs" : anyWorking ? "working" : "idle";
  const caption = waiting.length ? `${waiting[0].title} needs your OK` : anyWorking ? "Working on it…" : "Ready when you are.";

  // The home screen's tiles; where each sits is the person's (dragged), saved with the look.
  const boardItems: BoardItem[] = [
    {
      id: "assistant", label: "the assistant", x: 3, y: 0, w: 6, h: 8, minW: 3, minH: 5, grabAnywhere: true,
      node: (
        <div class="mascot-wrap">
          <button class="mascot-btn" aria-label="Talk to Aelvyril" onClick={() => switchTo("stream")}>
            <Mascot mood={mood} />
          </button>
          <p class={`mascot-line ${mood}`}>{caption}</p>
          <TaskChips list={going} label="Going on now" onOpen={openTask} onMore={() => switchTo("inbox")} />
        </div>
      ),
    },
    {
      id: "chat", label: "the chat box", x: 3, y: 8, w: 6, h: 5, minW: 3, minH: 3,
      node: (
        <div class="home-chat">
          <HomeRecent items={stream.t.items} live={stream.live} onOpenStream={() => switchTo("stream")} />
          <HomeAsk onSubmit={askFromHome} />
        </div>
      ),
    },
    ...widgets.list.map((w) => ({
      id: `w:${w.id}`, label: w.title, w: 3, h: 4, minW: 2, minH: 3, grabAnywhere: true,
      node: <WidgetCard w={w} onAsk={askFromHome} onRemoved={widgets.pull} />,
    })),
    ...projects.list.map((p) => ({
      id: `p:${p.id}`, label: p.name, w: 4, h: 5, minW: 3, minH: 4, grabAnywhere: true,
      node: <ProjectCard p={p} onChanged={projects.pull} onPreview={setPreviewing} />,
    })),
  ];
  const saveLayout = (layout: Layout) => {
    setDesign((d) => ({ ...d, layout }));
    api.setDesign({ layout }).catch(() => {});
  };

  return (
    <div class={`shell ${sheetOpen && !phone ? "shift" : ""} ${atHome ? "at-home" : ""} ${narrow || design.home === "grid" ? "home-stack" : ""}`}>
      <header class="beam">
        <div class="brand"><span class="label-mark">Aelvyril</span></div>
        {unlocked && !onHome && (
          <button class="home-btn" onClick={goHome}>
            <IconHome />
            <span>Home</span>
          </button>
        )}
        {unlocked && !onHome && !settings && <span class="crumb" aria-hidden="true">{viewLabel}</span>}
        {!onHome && (
          <button class={`icon-btn gear ${settings ? "on" : ""}`} aria-label="Settings" title="Settings" onClick={() => openSettings()}>
            <IconSettings />
            <span class="gear-label" aria-hidden="true">Settings</span>
          </button>
        )}
      </header>

      {unlocked && (
        <section class="home" aria-label="Home" inert={!atHome || !!settings}>
          <HomeBoard items={boardItems} saved={design.layout ?? {}} onSave={saveLayout} />
          <nav class="dock" aria-label="Go to">
            <Switcher current={current} needs={waiting.length} running={going.length - waiting.length} onPick={switchTo} />
            <button class="dock-btn" onClick={() => openSettings()} aria-label="Settings">
              <IconSettings />
              <span>{hasAI === false ? "Connect an AI" : "Settings"}</span>
            </button>
          </nav>
        </section>
      )}

      {strip.length > 0 && !settings && !atHome && current !== "inbox" && (
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
        class={`views ${atHome ? "" : "shown"}`}
        inert={!!settings || atHome || (phone && !!taskId) || overlay}
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
          <Settings initialTab={settings} onBack={() => { setSettings(null); checkAI(); loadName(); }} onSignOut={onSignOut} />
        </div>
      )}

      {previewing && <PreviewModal p={previewing} onClose={() => setPreviewing(null)} />}

      {overlay && (
        <div class="modal-back quick-back" onClick={(e) => e.target === e.currentTarget && setOverlay(false)}>
          <div ref={overlayRef} class="modal quick-modal" role="dialog" aria-modal="true" aria-label="Quick" onKeyDown={(e) => trapTab(e, overlayRef.current)}>
            <Quick threads={threads} onSubmit={submitQuick} onOpenTask={openTask} />
            <p class="muted small quick-esc"><kbd>Esc</kbd> to close</p>
          </div>
        </div>
      )}

      <div class="sr-only" role="status" aria-live="polite">{said}</div>
    </div>
  );
}

/** The page opened at this moment: an exchange from before it is history (it lives in the Stream), not news. */
const PAGE_OPENED = Date.now();

/** The current exchange, under the orb on the home screen: your last message and the answer as it arrives.
    It stays until the next exchange replaces it or you hide it (×); after a reload it is gone. */
function HomeRecent({ items, live, onOpenStream }: { items: Item[]; live: string; onOpenStream(): void }) {
  // The exchange starts at your last message, or at the hand-off of a finished task's result (a reply to that is new, your old question is not).
  let from = 0;
  items.forEach((i, n) => { if (i.kind === "user" || i.kind === "handoff") from = n + (i.kind === "handoff" ? 1 : 0); });
  const recent = items.slice(from).filter((i) => (i.kind === "user" || i.kind === "assistant") && i.text.trim());
  const id = items[Math.max(0, from - 1)]?.key ?? "";
  // By the clock, not by "something changed": history still arriving when the page opens never counts as new.
  const begun = Math.max(0, ...recent.map((i) => ("at" in i && i.at) || 0));
  const [hidden, setHidden] = useState("");
  const sig = `${recent.length}:${live.length}`;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [sig]);
  if ((!recent.length && !live) || begun < PAGE_OPENED || hidden === id) return null;
  return (
    <div class="home-recent">
      <div class="hr-log" ref={box} role="log" aria-label="Current exchange">
        {recent.map((i) =>
          i.kind === "user" ? <p class="hr-you" key={i.key}>{i.text}</p> : i.kind === "assistant" ? <div class="hr-ai" key={i.key}><Markdown text={i.text} /></div> : null,
        )}
        {live && <div class="hr-ai" aria-hidden="true"><Markdown text={live} /></div>}
      </div>
      <div class="hr-foot">
        <button class="link hr-open" onClick={onOpenStream}>Open the Stream <IconArrow /></button>
        <button class="icon-btn hr-hide" aria-label="Hide this exchange" title="Hide" onClick={() => setHidden(id)}><IconClose /></button>
      </div>
    </div>
  );
}

/** The cards the assistant put on the home screen (widgets): read now and every 20 seconds. Ask for one in the chat. */
function useWidgets() {
  const [list, setList] = useState<WidgetRow[]>([]);
  const pull = useCallback(() => api.widgets().then(setList).catch(() => {}), []);
  useEffect(() => {
    pull();
    const t = setInterval(pull, 20_000);
    return () => clearInterval(t);
  }, []);
  return { list, pull };
}

/** One widget's card: its title, the card the gateway filled in, and when it was last updated. */
function WidgetCard({ w, onAsk, onRemoved }: { w: WidgetRow; onAsk(text: string): Promise<unknown>; onRemoved(): void }) {
  const [asking, setAsking] = useState(false);
  const now = Date.now();
  return (
    <article class={`widget ${w.error ? "has-error" : ""}`} aria-labelledby={`w-${w.id}`}>
      <header class="widget-head">
        <h2 id={`w-${w.id}`}>{w.title}</h2>
        {asking ? (
          <span class="row">
            <button class="link danger-link" onClick={() => api.removeWidget(w.id).then(onRemoved).finally(() => setAsking(false))}>Remove</button>
            <button class="link" onClick={() => setAsking(false)}>Keep</button>
          </span>
        ) : (
          <button class="icon-btn widget-x" aria-label={`Remove ${w.title}`} title="Remove" onClick={() => setAsking(true)}><IconClose /></button>
        )}
      </header>
      <PanelView panel={{ ...w.panel, title: undefined }} onCommand={(c) => void onAsk(c)} />
      <p class="widget-foot">
        {w.error ? <span class="widget-err" title={w.error}>Couldn't update · </span> : null}
        {w.every ? `Updated ${ago(w.updated_at, now)} · every ${w.every >= 60 && w.every % 60 === 0 ? `${w.every / 60} h` : `${w.every} min`}` : `Updated ${ago(w.updated_at, now)}`}
      </p>
    </article>
  );
}

/** The chat box under the assistant on the home screen: sends to the Stream and stays here. */
function HomeAsk({ onSubmit }: { onSubmit(text: string): Promise<unknown> }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const send = async (e: Event) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setErr("");
    try {
      await onSubmit(t);
      setText("");
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  return (
    <form class="home-ask" onSubmit={send}>
      <input aria-label="Ask Aelvyril" placeholder="Ask anything…" autocomplete="off" value={text} onInput={(e) => setText(e.currentTarget.value)} />
      <button class="btn primary" type="submit" disabled={!text.trim()}>Send</button>
      {err && <p class="notice error">{err}</p>}
    </form>
  );
}

const VIEW_ICON: Record<ViewId, () => preact.JSX.Element> = { stream: IconStream, inbox: IconInbox };

/** Stream and Tasks (read from VIEWS): a quiet row along the bottom of the home screen.
    Still a real tablist (arrows, Home, End); picking one slides that screen in. */
function Switcher({ current, needs, running, onPick }: { current: ViewId | null; needs: number; running: number; onPick(v: ViewId): void }) {
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
    <div class="switcher" role="tablist" aria-label="Views">
      {VIEWS.map((v, i) => (
        <button
          ref={(el) => void (refs.current[i] = el)}
          role="tab"
          id={`tab-${v.id}`}
          class={`dock-btn ${v.id === "inbox" && needs > 0 ? "needs" : ""}`}
          aria-selected={i === idx}
          aria-controls={`view-${v.id}`}
          aria-describedby={v.id === "inbox" && needs > 0 ? "inbox-needs" : undefined}
          tabIndex={i === Math.max(idx, 0) ? 0 : -1}
          onClick={() => onPick(v.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {VIEW_ICON[v.id]()}
          <span>{v.label}</span>
          {v.id === "inbox" && needs > 0 && <span class="badge" aria-hidden="true">{needs}</span>}
          {v.id === "inbox" && running > 0 && <span class="badge run" aria-label={running === 1 ? "1 running" : `${running} running`}>{running}</span>}
        </button>
      ))}
      <span id="inbox-needs" class="sr-only">{needs === 1 ? "1 task needs you" : `${needs} tasks need you`}</span>
    </div>
  );
}
