import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { RouteLine } from "./route-line.js";

/** The lamp span is the first child of the station wrapper. */
function node(station: string): HTMLElement {
  return screen.getByTestId(`route-station-${station}`).firstElementChild as HTMLElement;
}

describe("RouteLine", () => {
  beforeEach(() => cleanup());

  it("running lights the run station with the go aspect and pulse", () => {
    render(<RouteLine status="running" />);
    expect(node("run").className).toContain("bg-go");
    expect(node("run").className).toContain("animate-lamp-pulse");
    // Passed stations stay lit dim; not-yet-reached ones stay dark.
    expect(node("spec").className).toContain("bg-seam-strong");
    expect(node("verify").className).toContain("border-seam");
    expect(node("verify").className).not.toContain("bg-go");
  });

  it("merged lights the merge station with the go lamp", () => {
    render(<RouteLine status="merged" />);
    expect(node("merge").className).toContain("border-go");
    // The whole line up to merge is traversed: every connector is lit
    // (blue = the set route; the merge lamp itself is the hollow go aspect).
    const nav = screen.getByTestId("route-line");
    const lit = Array.from(nav.children).filter((el) => (el as HTMLElement).className.includes("bg-route/60"));
    expect(lit.length).toBe(4);
  });

  it("draft lights nothing — all stations dark, no lamp, no lit connector", () => {
    render(<RouteLine status="draft" />);
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
