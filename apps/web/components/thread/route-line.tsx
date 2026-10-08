import { Fragment } from "react";
import type { ThreadStatus } from "@aelvyril/shared";
import { ROUTE_STATIONS, STATUS_META, routePosition } from "../../lib/design.js";

/**
 * The desk's route strip: the thread's lifecycle as a horizontal station
 * line. The active station carries the status's signal aspect (its lamp
 * breathes while the phase is live); stations the route already passed stay
 * lit dim; future ones stay dark until the line reaches them.
 */
export function RouteLine({ status }: { status: ThreadStatus }) {
  const { reached, active } = routePosition(status);
  const meta = STATUS_META[status];
  const reachedIdx = ROUTE_STATIONS.indexOf(reached);

  return (
    <nav aria-label="Thread route" data-testid="route-line" className="flex items-center gap-0 px-4 py-3">
      {ROUTE_STATIONS.map((station, i) => {
        const isActive = station === active;
        const passed = i < reachedIdx;
        const nodeClass = isActive
          ? `${meta.lampClass}${meta.pulse ? " animate-lamp-pulse" : ""}`
          : passed
            ? "bg-seam-strong"
            : "border border-seam bg-transparent";
        const labelClass = isActive ? "text-ink" : "text-ink-faint";
        return (
          <Fragment key={station}>
            {i > 0 && (
              <span
                aria-hidden
                className={`h-px flex-1 ${i <= reachedIdx ? "bg-route/60" : "bg-seam"}`}
              />
            )}
            <span data-testid={`route-station-${station}`} className="flex items-center gap-1.5">
              <span aria-hidden className={`size-2.5 rounded-full ${nodeClass}`} />
              <span className={`font-mono text-xs uppercase tracking-wider ${labelClass}`}>{station}</span>
            </span>
          </Fragment>
        );
      })}
    </nav>
  );
}
