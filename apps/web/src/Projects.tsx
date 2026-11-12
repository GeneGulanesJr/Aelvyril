// Coding projects on the home screen: each is a card (is its sandbox running, how much CPU, memory and disk it uses,
// start/stop, publish), and clicking it opens its app in a preview window.
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api, type ProjectRow } from "./api.ts";
import { IconClose } from "./icons.tsx";

/** Read now and every 5 seconds (the numbers move). */
export function useProjects() {
  const [list, setList] = useState<ProjectRow[]>([]);
  const pull = useCallback(() => api.projects().then((d) => setList(d.projects)).catch(() => {}), []);
  useEffect(() => {
    pull();
    const t = setInterval(pull, 5000);
    return () => clearInterval(t);
  }, []);
  return { list, pull };
}

const size = (b?: number | null) => (b == null || !Number.isFinite(b) ? "–" : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
const STATE: Record<string, string> = { running: "Running", stopped: "Stopped", missing: "Gone", unknown: "Can't tell" };

export function ProjectCard({ p, onChanged, onPreview }: { p: ProjectRow; onChanged(): void; onPreview(p: ProjectRow): void }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const s = p.status;
  const up = s.state === "running";
  const act = (a: string) => async () => {
    setBusy(a);
    setError("");
    try {
      if (a === "delete") await api.deleteProject(p.id);
      else await api.projectAction(p.id, a);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy("");
    onChanged();
  };
  const memPct = s.memUsed && s.memLimit ? Math.round((s.memUsed / s.memLimit) * 100) : 0;
  return (
    <article class={`widget project-card ${up ? "is-up" : ""}`} aria-labelledby={`p-${p.id}`} onClick={(e) => p.preview && s.app && !(e.target as HTMLElement).closest("button, a") && onPreview(p)}>
      <header class="widget-head">
        <h2 id={`p-${p.id}`}>{p.name}</h2>
        <span class={`pc-state s-${s.state}`}>{STATE[s.state] ?? s.state}</span>
      </header>
      <p class="pc-sub">{p.repo ? `${p.repo} · ${p.branch}` : "No GitHub repo"}</p>
      <dl class="pc-stats">
        <div><dt>CPU</dt><dd>{up ? `${s.cpu ?? 0}%` : "–"}</dd></div>
        <div><dt>Memory</dt><dd>{up ? `${size(s.memUsed)} of ${size(s.memLimit)}` : "–"}</dd></div>
        <div><dt>Disk</dt><dd>{size(s.disk)}</dd></div>
      </dl>
      {up && <span class="pc-meter" aria-hidden="true"><i style={{ width: `${memPct}%` }} /></span>}
      {p.run && (
        <p class="pc-app">
          App: <strong>{up && s.app ? "running" : "not running"}</strong>
          {up && s.app && <button class="link" onClick={() => onPreview(p)}>Open preview</button>}
        </p>
      )}
      {p.push && (
        <div class="pc-push">
          <span>Ready to publish: <strong>{p.push.title}</strong></span>
          <button class="btn primary" disabled={!!busy} onClick={act("push")}>{busy === "push" ? "Pushing…" : "Push and open PR"}</button>
        </div>
      )}
      {p.pr && <a class="link" href={p.pr} target="_blank" rel="noreferrer">Pull request</a>}
      {error && <p class="notice error">{error}</p>}
      <div class="pc-actions">
        {up ? <button class="btn" disabled={!!busy} onClick={act("stop")}>Stop</button> : s.state === "stopped" && <button class="btn" disabled={!!busy} onClick={act("start")}>Start</button>}
        {up && p.run && (s.app ? <button class="btn" disabled={!!busy} onClick={act("halt")}>Stop app</button> : <button class="btn" disabled={!!busy} onClick={act("run")}>Run app</button>)}
        <span class="grow" />
        {deleting ? (
          <span class="row">
            <button class="btn danger" disabled={!!busy} onClick={act("delete")}>Delete for good</button>
            <button class="link" onClick={() => setDeleting(false)}>Keep</button>
          </span>
        ) : (
          <button class="icon-btn widget-x" aria-label={`Delete ${p.name}`} title="Delete the project and its sandbox" onClick={() => setDeleting(true)}><IconClose /></button>
        )}
      </div>
    </article>
  );
}

/** The project's app in a window over the home screen. The frame is sandboxed (and the server says so too), so the app
    runs without Aelvyril's origin: it can't reach the person's session. */
export function PreviewModal({ p, onClose }: { p: ProjectRow; onClose(): void }) {
  const [n, setN] = useState(0);
  const [log, setLog] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);
  const showLog = () => (log === null ? api.projectLog(p.id).then((d) => setLog(d.log || "(empty)"), (e) => setLog(e.message)) : setLog(null));
  return (
    <div class="modal-back preview-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="preview-win" role="dialog" aria-modal="true" aria-label={`${p.name} preview`}>
        <header class="preview-bar">
          <strong>{p.name}</strong>
          <span class="muted small">Dev preview</span>
          <span class="grow" />
          <button class="btn" onClick={() => setN(n + 1)}>Reload</button>
          <button class="btn" onClick={showLog}>{log === null ? "Log" : "Hide log"}</button>
          <button ref={closeRef} class="icon-btn" aria-label="Close preview" onClick={onClose}><IconClose /></button>
        </header>
        {log !== null && <pre class="preview-log">{log}</pre>}
        <iframe key={n} class="preview-frame" title={`${p.name} app`} src={p.preview} sandbox="allow-scripts allow-forms allow-popups allow-modals" />
      </div>
    </div>
  );
}
