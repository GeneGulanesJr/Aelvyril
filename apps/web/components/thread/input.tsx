"use client";
import { useState } from "react";

export function ThreadInput({ onAsk, disabled, waiting = false, onStop }: {
  onAsk: (prompt: string, mode: "auto" | "force" | "off") => void;
  disabled: boolean;
  /** A turn is in flight — shows Stop (spec §6: sends queue as steers). */
  waiting?: boolean;
  onStop?: () => void;
}) {
  const [text, setText] = useState("");
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
          disabled={disabled || !text.trim()}
          onClick={() => { onAsk(text, "auto"); setText(""); }}
        >Ask</button>
        <button
          className="rounded border border-[#2b3245] bg-[#161b27] px-3 py-1 text-sm disabled:opacity-40"
          data-testid="ask-spec-button"
          disabled={disabled || !text.trim()}
          onClick={() => { onAsk(text, "force"); setText(""); }}
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
