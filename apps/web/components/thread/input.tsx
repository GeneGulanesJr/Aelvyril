"use client";
import { useState } from "react";

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

  return (
    <div className="border-t border-[#2b3245] bg-[#0d1117] p-3">
      <textarea
        className="w-full resize-none rounded border border-[#2b3245] bg-[#161b27] p-2 text-sm focus:border-[#1f6feb] focus:outline-none"
        data-testid="thread-input"
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ask anything..."
        rows={3}
        value={text}
      />
      <div className="mt-2 flex gap-2">
        <button
          className="rounded bg-[#1f6feb] px-3 py-1 text-sm font-medium disabled:opacity-40"
          data-testid="ask-button"
          disabled={disabled || submitting || !text.trim()}
          onClick={() => send("auto")}
        >Ask</button>
        <button
          className="rounded border border-[#2b3245] bg-[#161b27] px-3 py-1 text-sm disabled:opacity-40"
          data-testid="ask-spec-button"
          disabled={disabled || submitting || !text.trim()}
          onClick={() => send("force")}
        >Ask + spec</button>
        {waiting && onStop && (
          <button
            className="rounded border border-[#f85149]/50 bg-[#f85149]/10 px-3 py-1 text-sm text-[#f85149]"
            data-testid="stop-button"
            onClick={onStop}
          >Stop</button>
        )}
      </div>
    </div>
  );
}
