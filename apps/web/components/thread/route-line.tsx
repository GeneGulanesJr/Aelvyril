"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import type { ThreadStatus } from "@aelvyril/shared";
import { ROUTE_STATIONS, STATUS_META, routePosition } from "../../lib/design.js";
import { Engineer, type EngineerLamp, type EngineerPose } from "../crew/engineer.js";
import { useUiMode } from "../crew/ui-mode.js";
import { CrewToken, type CrewUnit } from "../crew/crew-token.js";

/**
 * The engineer's pose and lamp derive only from real run state — the
 * animation encodes the run, it never decorates. Degraded outranks
 * everything (the host died — no cheery work), merged is the only done.
 */
function engineerFor(status: ThreadStatus, degraded: boolean): { pose: EngineerPose; lamp: EngineerLamp } {
  if (degraded) return { pose: "unplugged", lamp: "off" };
  switch (status) {
    case "running":
      return { pose: "working", lamp: "go" };
    case "spec'ing":
      return { pose: "working", lamp: "caution" };
    case "queued":
      return { pose: "idle", lamp: "caution" }; // on the platform
    case "draft":
      return { pose: "idle", lamp: "off" };
    case "abandoned":
      return { pose: "idle", lamp: "danger" };
    case "reviewed":
      return { pose: "idle", lamp: "go" }; // standing at REVIEW, waiting on you
    case "merged":
      return { pose: "done", lamp: "go" };
  }
}

/** The one orchestrated motion moment: the walk between stations. */
const WALK_MS = 620; // matches the left-position transition on the crew track

/** Crew track geometry: 5 stations, evenly spaced percentages. */
const stationLeft = (i: number) => `${(i / (ROUTE_STATIONS.length - 1)) * 100}%`;

/**
 * The route strip: the thread's lifecycle as a horizontal station line. The
 * active station carries the status's signal aspect (its lamp breathes while
 * the phase is live); stations the route already passed stay lit dim; future
 * ones stay dark until the line reaches them.
 *
 * Crew mode inhabits the strip RTS-style: the engineer WALKS the rail
 * (left position transitions between stations, walking pose en route), work
 * sparks ring the station while a tool executes, and dispatched crew drones
 * hover in the yard below with their real task on hover. Desk mode renders
 * the bare signal line — byte-for-byte.
 */
export function RouteLine({ status, degraded = false, crew = [], workPending = false }: {
  status: ThreadStatus;
  degraded?: boolean;
  /** Dispatched subagents (name + real task from the subagent_spawn envelope). */
  crew?: CrewUnit[];
  /** True while a tool call is in flight — drives the work sparks. */
  workPending?: boolean;
}) {
  const { reached, active } = routePosition(status);
  const meta = STATUS_META[status];
  const reachedIdx = ROUTE_STATIONS.indexOf(reached);
  const { mode } = useUiMode();
  const crewMode = mode === "crew";

  // Where the engineer stands: the active station — or, for the platform
  // states (draft/queued/abandoned map to no active station), where the
  // route has reached (spec, the platform).
  const anchor = active ?? reached;
  const anchorIdx = ROUTE_STATIONS.indexOf(anchor);
  const mapped = engineerFor(status, degraded);

  // The walk: when the anchor station changes, hold the walking pose for
  // WALK_MS while `left` transitions to the new station (the sprite faces
  // the direction of travel). Then settle into the mapped pose.
  const [walk, setWalk] = useState<{ from: number } | null>(null);
  const prevIdx = useRef<number | null>(null);
  useEffect(() => {
    if (!crewMode) {
      prevIdx.current = null;
      setWalk(null);
      return;
    }
    const prev = prevIdx.current;
    prevIdx.current = anchorIdx;
    if (prev === null || prev === anchorIdx) return;
    setWalk({ from: prev });
    const settle = window.setTimeout(() => setWalk(null), WALK_MS);
    return () => {
      window.clearTimeout(settle);
    };
  }, [crewMode, anchorIdx]);

  const walkDir = walk ? Math.sign(anchorIdx - walk.from) : 0;
  const pose: EngineerPose = degraded ? "unplugged" : walk ? "walking" : mapped.pose;
  const lamp = mapped.lamp;
  const flip = walk ? walkDir < 0 : false;

  if (!crewMode) {
    const stations = ROUTE_STATIONS.map((station, i) => {
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
    });
    return (
      <nav aria-label="Thread route" data-testid="route-line" className="flex items-center gap-0 px-4 py-3">
        {stations}
      </nav>
    );
  }

  // ── Crew track: fixed-proportion layout so unit positions are exact. ──
  const stationNode = (station: string, i: number) => {
    const isActive = station === active;
    const passed = i < reachedIdx;
    const nodeClass = isActive
      ? `${meta.lampClass}${meta.pulse ? " animate-lamp-pulse" : ""}`
      : passed
        ? "bg-seam-strong"
        : "border border-seam bg-transparent";
    const labelClass = isActive ? "text-ink" : "text-ink-faint";
    return (
      <div
        key={station}
        data-testid={`route-station-${station}`}
        className="absolute top-0 flex -translate-x-1/2 flex-col items-center gap-1.5"
        style={{ left: stationLeft(i) }}
      >
        <span aria-hidden className={`size-2.5 rounded-full ${nodeClass}`} />
        <span className={`font-mono text-xs uppercase tracking-wider ${labelClass}`}>{station}</span>
      </div>
    );
  };

  return (
    <nav
      aria-label="Thread route"
      data-testid="route-line"
      className="px-4 pb-24 pt-16"
    >
      <div className="relative mx-10 h-24">
        {/* the rail — passed portion lit like the desk route */}
        <div aria-hidden className="absolute left-0 right-0 top-[5px] h-px bg-seam" />
        <div
          aria-hidden
          className="absolute left-0 top-[5px] h-px bg-route/60"
          style={{ width: `${(reachedIdx / (ROUTE_STATIONS.length - 1)) * 100}%` }}
        />

        {ROUTE_STATIONS.map((station, i) => stationNode(station, i))}

        {/* the engineer walks the rail */}
        <div
          data-testid="crew-engineer"
          data-pose={pose}
          className="absolute top-[-56px] z-10 -translate-x-1/2 transition-[left] duration-[600ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
          style={{ left: stationLeft(anchorIdx) }}
        >
          {/* work sparks ring the station while a tool executes */}
          {workPending && !degraded && (
            <span
              aria-hidden
              className="crew-spark absolute left-1/2 top-[46px] size-12 rounded-full border-2 border-caution/50"
            />
          )}
          <Engineer pose={pose} lamp={lamp} flip={flip} className="h-14 w-12" />
        </div>

        {/* the dispatched crew hover in the yard below */}
        <div className="absolute inset-x-0 top-[52px] flex items-start justify-center gap-5">
          <CrewToken units={crew} active={!degraded && (status === "running" || status === "spec'ing")} />
        </div>
      </div>
    </nav>
  );
}
