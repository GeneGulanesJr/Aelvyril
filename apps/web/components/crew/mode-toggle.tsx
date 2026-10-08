"use client";
import { TrainFront, Users } from "lucide-react";
import { useUiMode, type UiMode } from "./ui-mode.js";

const OPTIONS: Array<{ mode: UiMode; label: string; Icon: typeof TrainFront; testId: string }> = [
  { mode: "desk", label: "Dispatch", Icon: TrainFront, testId: "ui-mode-desk" },
  { mode: "crew", label: "Crew", Icon: Users, testId: "ui-mode-crew" },
];

/** Segmented control between the two product faces: the dispatch desk and the
 *  inhabited crew view. Labels stay visible — they are the modes' product names,
 *  not tooltips. */
export function ModeToggle() {
  const { mode, setMode } = useUiMode();
  return (
    <div
      className="inline-flex items-center rounded-md border border-seam bg-panel-raised p-0.5"
      role="group"
      aria-label="Interface mode"
      data-testid="ui-mode-toggle"
    >
      {OPTIONS.map(({ mode: value, label, Icon, testId }) => {
        const active = mode === value;
        return (
          <button
            key={value}
            aria-pressed={active}
            className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs font-mono uppercase tracking-wider transition-colors duration-150 ${
              active ? "bg-panel-active text-ink" : "text-ink-faint hover:text-ink-muted"
            }`}
            data-testid={testId}
            onClick={() => setMode(value)}
          >
            <Icon aria-hidden className="size-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
