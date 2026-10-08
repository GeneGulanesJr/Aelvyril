"use client";
import type { JSX } from "react";


/**
 * A crew drone — the small unit the main engineer dispatches. Authored
 * sprite (never an emoji): a hovering repair drone with a caution visor.
 * Like the engineer, it is aria-hidden: its task text lives in the trace,
 * which stays the authoritative surface.
 */
export function Drone({
  active,
  className = "h-7 w-7",
}: {
  /** True while the run the drone was spawned for is still executing. */
  active?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <svg viewBox="0 0 28 24" aria-hidden className={`${className} ${active ? "crew-drone-hover" : ""}`} data-active={active ? "true" : "false"}>
      {/* thruster flame while active */}
      {active && (
        <path d="M14 21 q-1.6 2.4 0 3 q1.6 -0.6 0 -3" className="fill-caution crew-drone-flame" />
      )}
      {/* body */}
      <ellipse cx="14" cy="13" rx="8.5" ry="6.5" className="fill-panel-active stroke-seam-strong" strokeWidth="1" />
      {/* visor */}
      <path d="M8.5 12 a5.5 4 0 0 1 11 0 z" className="fill-caution/70" />
      {/* side thruster pods */}
      <rect x="2.2" y="12" width="3" height="4.4" rx="1.2" className="fill-panel-raised stroke-seam-strong" strokeWidth="0.8" />
      <rect x="22.8" y="12" width="3" height="4.4" rx="1.2" className="fill-panel-raised stroke-seam-strong" strokeWidth="0.8" />
      {/* status dot */}
      <circle cx="14" cy="16.6" r="1.4" className={active ? "fill-go animate-lamp-pulse" : "fill-lamp-off"} />
    </svg>
  );
}
