"use client";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ClipboardList, SendHorizontal, Square } from "lucide-react";

export function ThreadInput({ onAsk, disabled, waiting = false, onStop, submitting = false }: {
  /** Promise-returning callers report the send outcome: resolve `false` (ask
   *  failure) or reject (failed create) both keep the text; resolve
   *  `true`/`undefined` clears it. Sync (fire-and-forget) callers clear now. */
  onAsk: (prompt: string, mode: "auto" | "force" | "off") => void | boolean | Promise<void | boolean>;
  disabled: boolean;
  /** A turn is in flight — shows Stop (spec §6: sends queue as steers). */
  waiting?: boolean;
  /** Create/prompt round-trip in flight — disables both send buttons. */
  submitting?: boolean;
  onStop?: () => void;
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow: re-measure on every value change, capped at 200px — beyond
  // that the textarea scrolls internally instead of pushing the page.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const canSend = !disabled && !submitting && text.trim().length > 0;

  const send = (mode: "auto" | "force") => {
    const result = onAsk(text, mode);
    if (result instanceof Promise) {
      void result
        .then((ok) => {
          // `false` is the existing-thread ask failure contract — keep the
          // typed message so the user can retry.
          if (ok !== false) setText("");
        })
        .catch(() => {}); // rejected callers keep the text (failed create)
    } else if (result !== false) {
      setText("");
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter") return;
    // Shift+Enter keeps the newline; Enter during IME composition confirms
    // the composition instead of sending.
    if (e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (canSend) send("auto");
  };

  return (
    <div className="border-t border-seam bg-panel p-3">
      <textarea
        className="min-h-[3.4rem] w-full resize-none rounded-md border border-seam bg-panel-raised p-3 text-sm text-ink transition-colors placeholder:text-ink-faint focus:border-route"
        data-testid="thread-input"
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ask anything..."
        ref={inputRef}
        rows={1}
        value={text}
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          className="inline-flex items-center gap-1.5 rounded-md bg-route px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-route/90 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="ask-button"
          disabled={disabled || submitting || !text.trim()}
          onClick={() => send("auto")}
        >
          <SendHorizontal aria-hidden className="size-3.5" />
          Ask
        </button>
        <button
          className="inline-flex items-center gap-1.5 rounded-md border border-seam-strong px-3.5 py-1.5 text-sm text-ink-muted transition-colors hover:border-ink-faint hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="ask-spec-button"
          disabled={disabled || submitting || !text.trim()}
          onClick={() => send("force")}
        >
          <ClipboardList aria-hidden className="size-3.5" />
          Ask + spec
        </button>
        {waiting && onStop && (
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-danger/60 px-3.5 py-1.5 text-sm text-danger transition-colors hover:bg-danger/10"
            data-testid="stop-button"
            onClick={onStop}
          >
            <Square aria-hidden className="size-3" />
            Stop
          </button>
        )}
        {!waiting && (
          <span className="ml-auto hidden whitespace-nowrap text-xs text-ink-faint sm:inline">Enter to send · Shift+Enter for a new line</span>
        )}
        {waiting && text.length > 0 && (
          <span className="ml-auto hidden whitespace-nowrap text-xs text-ink-faint sm:inline">will queue as a steer</span>
        )}
      </div>
    </div>
  );
}
