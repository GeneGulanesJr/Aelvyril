"use client";
import type { JSX } from "react";
import { Drone } from "./drone.js";
import { useUiMode } from "./ui-mode.js";

/** A dispatched subagent: real name + real task from the subagent_spawn envelope. */
export type CrewUnit = { name: string; task: string };

const MAX_UNITS = 4;

/**
 * The dispatched crew, RTS-style: hovering drone units in the yard below the
 * route rail. Hovering a unit shows the task it was actually spawned with —
 * the trace stays the authoritative surface (drones are aria-hidden).
 */
export function CrewToken({ units, active = false }: {
  units: CrewUnit[];
  /** True while the run that spawned the crew is still executing. */
  active?: boolean;
}): JSX.Element | null {
  const { mode } = useUiMode();
  if (mode !== "crew" || units.length === 0) return null;

  const shown = units.slice(0, MAX_UNITS);
  const overflow = units.length - shown.length;

  return (
    <div data-testid="crew-token" className="flex items-start gap-5">
      {shown.map((unit) => (
        <div key={unit.name} className="group relative flex -translate-y-1 flex-col items-center gap-0.5">
          {/* the orders — real task text from the spawn envelope */}
          <div
            className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 hidden w-56 -translate-x-1/2 rounded-md border border-seam bg-panel-raised px-2.5 py-1.5 text-xs leading-snug text-ink-muted shadow-pop group-hover:block"
          >
            <span className="font-mono text-ink-faint">{unit.name}: </span>
            {unit.task}
          </div>
          <Drone active={active} className="h-7 w-7 transition-transform duration-150 group-hover:-translate-y-0.5 motion-reduce:transition-none" />
          <span className="max-w-[76px] truncate font-mono text-xs text-ink-faint">{unit.name}</span>
        </div>
      ))}
      {overflow > 0 && (
        <span className="font-mono text-xs tabular-nums text-ink-faint">+{overflow}</span>
      )}
    </div>
  );
}
