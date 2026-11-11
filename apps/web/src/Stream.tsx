// The Stream: one endless conversation. Quick answers inline, bigger work as task cards.
import type { Ref } from "preact";
import { useState } from "preact/hooks";
import { api, type ThreadRow } from "./api.ts";
import type { Transcript } from "./transcript.ts";
import { Composer, useStickToBottom, Weave } from "./Thread.tsx";
import { greeting, SUGGESTIONS } from "./model.ts";

export function Stream({
  mainId,
  t,
  live,
  loaded,
  rows,
  hasAI,
  draft,
  setDraft,
  inputRef,
  anyWorking,
  onOpenTask,
  onOpenSettings,
  onChanged,
}: {
  mainId: string | null;
  t: Transcript;
  live: string;
  loaded: boolean;
  rows: Map<string, ThreadRow>;
  hasAI: boolean | null;
  draft: string;
  setDraft(v: string): void;
  inputRef: Ref<HTMLTextAreaElement>;
  anyWorking: boolean;
  onOpenTask(id: string): void;
  onOpenSettings(): void;
  onChanged(): void;
}) {
  const [error, setError] = useState("");
  const scroller = useStickToBottom([t.items.length, live, loaded]);
  const empty = loaded && t.items.length === 0 && !live;

  const send = async (message: string) => {
    if (!message.trim() || !mainId) return;
    setError("");
    try {
      await api.prompt(mainId, message);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const fill = (s: string) => {
    setDraft(`${s} `);
    const el = (inputRef as { current: HTMLTextAreaElement | null }).current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
    }
  };

  return (
    <div class="stream">
      <div class="scroll transcript" ref={scroller}>
        {empty && hasAI === false ? (
          <div class="hello">
            <div class="swatch" aria-hidden="true" />
            <h2>Welcome to Aelvyril</h2>
            <p>To start, connect an AI. You can use an account you already have, like Claude or ChatGPT.</p>
            <button class="btn primary" onClick={onOpenSettings}>Connect an AI</button>
          </div>
        ) : empty && hasAI ? (
          <div class="hello">
            <div class="swatch" aria-hidden="true" />
            <h2>{greeting(new Date().getHours())}</h2>
            <p>Ask me anything. For bigger jobs, like going through files or looking things up, I start a task and keep working on it while we talk.</p>
            <div class="suggest" role="group" aria-label="Ideas to start with">
              {SUGGESTIONS.map((s) => <button type="button" class="suggestion" onClick={() => fill(s)}>{s}</button>)}
            </div>
          </div>
        ) : (
          <Weave t={t} live={live} threadId={mainId ?? ""} label="Stream" rows={rows} onCommand={send} onOpenTask={onOpenTask} working={t.running || anyWorking} />
        )}
      </div>
      {Object.keys(t.status).length > 0 && (
        <div class="statusline">{Object.values(t.status).map((s) => <span class="chip">{s}</span>)}</div>
      )}
      {error && <div class="notice error bar-notice">{error} <button class="link" onClick={() => setError("")}>dismiss</button></div>}
      <Composer
        label="Message"
        placeholder="Ask anything…"
        value={draft}
        onValue={setDraft}
        onSend={send}
        running={t.running}
        onStop={() => mainId && api.abort(mainId).catch((e) => setError(e.message))}
        inputRef={inputRef}
      />
    </div>
  );
}
