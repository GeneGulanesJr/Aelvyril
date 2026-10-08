import { cleanup, render, screen, act } from "@testing-library/react";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { useEffect, type ReactNode } from "react";
import { RouteLine } from "./route-line.js";
import { UIProvider, useUiMode } from "../crew/ui-mode.js";

// useUiMode throws outside a provider, and the provider's default mode is
// "desk" — so every render goes through UIProvider. Desk tests rely on the
// default; crew tests flip it with a probe, like the persisted toggle would.
function renderUi(ui: ReactNode) {
  return render(<UIProvider>{ui}</UIProvider>);
}

/** Probe: flips the provider's mode after mount. */
function ModeProbe({ mode }: { mode: "desk" | "crew" }) {
  const { setMode } = useUiMode();
  useEffect(() => {
    setMode(mode);
  }, [mode, setMode]);
  return null;
}

function renderCrew(ui: ReactNode) {
  return renderUi(
    <>
      <ModeProbe mode="crew" />
      {ui}
    </>,
  );
}

/** The lamp span is the first child of the station wrapper. */
function node(station: string): HTMLElement {
  return screen.getByTestId(`route-station-${station}`).firstElementChild as HTMLElement;
}

const CREW = [{ name: "scout", task: "Map every caller of refreshToken()" }];

describe("RouteLine", () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("running lights the run station with the go aspect and pulse", () => {
    renderUi(<RouteLine status="running" />);
    expect(node("run").className).toContain("bg-go");
    expect(node("run").className).toContain("animate-lamp-pulse");
    // Passed stations stay lit dim; not-yet-reached ones stay dark.
    expect(node("spec").className).toContain("bg-seam-strong");
    expect(node("verify").className).toContain("border-seam");
    expect(node("verify").className).not.toContain("bg-go");
  });

  it("merged lights the merge station with the go lamp", () => {
    renderUi(<RouteLine status="merged" />);
    expect(node("merge").className).toContain("border-go");
    // The whole line up to merge is traversed: every connector is lit
    // (blue = the set route; the merge lamp itself is the hollow go aspect).
    const nav = screen.getByTestId("route-line");
    const lit = Array.from(nav.children).filter((el) => (el as HTMLElement).className.includes("bg-route/60"));
    expect(lit.length).toBe(4);
  });

  it("draft lights nothing — all stations dark, no lamp, no lit connector", () => {
    renderUi(<RouteLine status="draft" />);
    expect(node("spec").className).toContain("border-seam");
    const nav = screen.getByTestId("route-line");
    const lit = Array.from(nav.children).filter(
      (el) =>
        (el as HTMLElement).className.includes("bg-go") ||
        (el as HTMLElement).className.includes("animate-lamp-pulse"),
    );
    expect(lit.length).toBe(0);
  });
});

describe("RouteLine (crew mode)", () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("the engineer walks the rail at the run station, working", () => {
    renderCrew(<RouteLine status="running" crew={CREW} />);
    const eng = screen.getByTestId("crew-engineer");
    expect(eng.getAttribute("data-pose")).toBe("working");
    expect(eng.querySelector('svg[data-pose="working"]')).toBeTruthy();
    expect(eng.querySelector(".fill-go")).toBeTruthy(); // running → lamp go
    // Station run sits at 25% of the crew track; the engineer stands there.
    expect(eng.style.left).toBe("25%");
    // The station row survives with all five stations.
    for (const s of ["spec", "run", "verify", "review", "merge"]) {
      expect(screen.getByTestId(`route-station-${s}`)).toBeTruthy();
    }
  });

  it("desk mode has no engineer, no sparks, and no crew token", () => {
    renderUi(<RouteLine status="running" crew={CREW} workPending />);
    expect(screen.queryByTestId("crew-engineer")).toBeNull();
    expect(screen.queryByTestId("crew-token")).toBeNull();
    expect(document.querySelector(".crew-spark")).toBeNull();
  });

  it("degraded outranks everything — unplugged pose, lamp off, no sparks", () => {
    renderCrew(<RouteLine status="running" degraded workPending />);
    const eng = screen.getByTestId("crew-engineer");
    expect(eng.getAttribute("data-pose")).toBe("unplugged");
    expect(eng.querySelector('svg[data-pose="unplugged"]')).toBeTruthy();
    expect(eng.querySelector(".fill-lamp-off")).toBeTruthy();
    expect(eng.querySelector(".fill-go")).toBeNull();
    expect(eng.querySelector(".crew-spark")).toBeNull();
  });

  it("work sparks ring the station only while a tool is in flight", () => {
    const { rerender } = renderCrew(<RouteLine status="running" crew={CREW} workPending />);
    expect(screen.getByTestId("crew-engineer").querySelector(".crew-spark")).toBeTruthy();
    rerender(
      <UIProvider>
        <ModeProbe mode="crew" />
        <RouteLine status="running" crew={CREW} workPending={false} />
      </UIProvider>,
    );
    expect(screen.getByTestId("crew-engineer").querySelector(".crew-spark")).toBeNull();
  });

  it("merged lands the engineer in the done pose at merge", () => {
    renderCrew(<RouteLine status="merged" />);
    const eng = screen.getByTestId("crew-engineer");
    expect(eng.getAttribute("data-pose")).toBe("done");
    expect(eng.style.left).toBe("100%");
  });

  it("a station change walks the rail: walking pose, left transition, faces travel", () => {
    vi.useFakeTimers();
    const { rerender } = renderCrew(<RouteLine status="spec'ing" />);
    // Keep the tree shape identical so RouteLine stays mounted (the walk
    // state machine lives across renders).
    rerender(
      <UIProvider>
        <ModeProbe mode="crew" />
        <RouteLine status="running" />
      </UIProvider>,
    );
    const eng = screen.getByTestId("crew-engineer");
    // spec (0) → run (1): walking pose, heading right (no flip), left gliding to 25%.
    expect(eng.getAttribute("data-pose")).toBe("walking");
    expect(eng.style.left).toBe("25%");
    const forward = eng.querySelector("svg")?.getAttribute("class") ?? "";
    expect(forward).not.toContain("-scale-x-100");
    // The walk settles into the mapped pose.
    act(() => {
      vi.advanceTimersByTime(650);
    });
    expect(eng.getAttribute("data-pose")).toBe("working");
  });

  it("walking backwards flips the sprite to face left", () => {
    vi.useFakeTimers();
    const { rerender } = renderCrew(<RouteLine status="merged" />);
    rerender(
      <UIProvider>
        <ModeProbe mode="crew" />
        <RouteLine status="running" />
      </UIProvider>,
    );
    const eng = screen.getByTestId("crew-engineer");
    expect(eng.getAttribute("data-pose")).toBe("walking");
    const flipped = eng.querySelector("svg")?.getAttribute("class") ?? "";
    expect(flipped).toContain("-scale-x-100");
  });
});
