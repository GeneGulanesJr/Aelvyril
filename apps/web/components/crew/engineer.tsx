"use client";
import type { JSX } from "react";

/**
 * The crew engineer — the desk's inhabitant. An authored rig, not an emoji:
 * a tiny signal technician whose helmet lamp carries the thread's aspect and
 * whose pose carries the run's state. Poses map 1:1 to real state (working =
 * status active at a station, attention = blocked/needs-you, unplugged =
 * degraded, done = merged) so the animation always encodes state, never
 * decorates. Reduced-motion freezes every animation via globals.css.
 */
export type EngineerPose = "idle" | "working" | "walking" | "attention" | "unplugged" | "done";

// No "route" lamp: blue is the set-route/primary-action color, never a status lamp (Aspect Rule).
export type EngineerLamp = "go" | "caution" | "danger" | "needsyou" | "off";

const LAMP_CLASS: Record<EngineerLamp, string> = {
  go: "fill-go",
  caution: "fill-caution",
  danger: "fill-danger",
  needsyou: "fill-needsyou",
  off: "fill-lamp-off",
};

const ARM_CLASS: Record<EngineerPose, string> = {
  idle: "crew-arm-rest",
  working: "crew-arm-work",
  walking: "crew-arm-swing",
  attention: "crew-arm-raise",
  unplugged: "crew-arm-rest",
  done: "crew-arm-raise-done",
};

export function Engineer({
  pose,
  lamp,
  flip = false,
  className = "h-9 w-8",
}: {
  pose: EngineerPose;
  lamp: EngineerLamp;
  flip?: boolean;
  className?: string;
}): JSX.Element {
  const lampClass = LAMP_CLASS[lamp];
  const facing = pose === "attention" || pose === "idle" || pose === "done" || pose === "unplugged";
  const helmetLampLive = pose === "working" || pose === "attention";
  const walking = pose === "walking";
  const slump = pose === "unplugged";

  return (
    // The figure carries no information the band, header, and lamps don't state
    // already - hidden from AT on purpose (crew adds no new information surfaces).
    <svg
      viewBox="0 0 32 36"
      aria-hidden
      className={`${className} ${flip ? "-scale-x-100" : ""} ${slump ? "crew-slump" : ""} ${walking ? "crew-bob" : ""}`}
      data-pose={pose}
    >
      {/* legs */}
      <g className={`crew-leg-a ${walking ? "crew-leg-swing-a" : ""}`} style={{ transformOrigin: "14px 27px" }}>
        <rect x="12.6" y="27" width="2.8" height="7" rx="1.4" className="fill-panel-active stroke-seam-strong" strokeWidth="1" />
      </g>
      <g className={`crew-leg-b ${walking ? "crew-leg-swing-b" : ""}`} style={{ transformOrigin: "18px 27px" }}>
        <rect x="16.6" y="27" width="2.8" height="7" rx="1.4" className="fill-panel-active stroke-seam-strong" strokeWidth="1" />
      </g>

      {/* body */}
      <rect x="10" y="17.5" width="12" height="10.5" rx="3" className="fill-panel-active stroke-seam-strong" strokeWidth="1" />
      <circle cx="16" cy="22.5" r="1.7" className={lampClass} />

      {/* left arm (static, at the side) */}
      <rect x="6.6" y="19" width="2.6" height="7.5" rx="1.3" className="fill-panel-active stroke-seam-strong" strokeWidth="1" />

      {/* right arm — the expressive limb */}
      <g className={ARM_CLASS[pose]} style={{ transformOrigin: "23px 19.5px" }}>
        <rect x="22.8" y="19" width="2.6" height="7.5" rx="1.3" className="fill-panel-active stroke-seam-strong" strokeWidth="1" />
      </g>

      {/* head + face */}
      <rect x="9.5" y="10.5" width="13" height="7" rx="2.5" className="fill-panel-raised stroke-seam-strong" strokeWidth="1" />
      {facing ? (
        <>
          <circle cx="13.4" cy="14" r="1.05" className="fill-ink" />
          <circle cx="18.6" cy="14" r="1.05" className="fill-ink" />
          {slump && <rect x="14.2" y="16.1" width="3.6" height="0.9" rx="0.45" className="fill-ink-faint" />}
        </>
      ) : (
        // profile: single eye, forward
        <circle cx="19.4" cy="14" r="1.05" className="fill-ink" />
      )}

      {/* helmet with signal lamp */}
      <path d="M8 10.5 a8 7 0 0 1 16 0 z" className="fill-panel-active stroke-seam-strong" strokeWidth="1" />
      <circle cx="16" cy="4.2" r="2.1" className={`${lampClass} ${helmetLampLive ? "animate-lamp-pulse" : ""}`} />

      {/* the dangling cord when unplugged */}
      {slump && (
        <g>
          <path d="M25 6 q3 2 2.5 6 t1 6" fill="none" className="stroke-seam-strong" strokeWidth="1.2" strokeLinecap="round" />
          <rect x="27.2" y="17.6" width="3.4" height="2.2" rx="0.8" className="fill-seam-strong" />
        </g>
      )}
    </svg>
  );
}
