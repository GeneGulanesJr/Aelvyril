import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { CrewToken, type CrewUnit } from "./crew-token.js";
import { UIProvider, useUiMode } from "./ui-mode.js";

/** Exposes the provider's mode so tests can wait for the post-mount adoption. */
function ModeProbe() {
  const { mode } = useUiMode();
  return <span data-testid="mode-probe" data-mode={mode} />;
}

/** Seed the persisted mode and wait for the provider to adopt it on mount. */
async function renderAsCrew(ui: ReactNode) {
  window.localStorage.setItem("aelvyril.ui-mode", "crew");
  render(
    <UIProvider>
      <ModeProbe />
      {ui}
    </UIProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId("mode-probe").getAttribute("data-mode")).toBe("crew"),
  );
}

const UNITS: CrewUnit[] = [
  { name: "scout", task: "Map every caller of refreshToken() across the gateway" },
  { name: "worker", task: "Patch the single-flight around the refresh promise" },
];

describe("CrewToken", () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("renders nothing with no crew to dispatch — even in crew mode", async () => {
    await renderAsCrew(<CrewToken units={[]} />);
    expect(screen.queryByTestId("crew-token")).toBeNull();
  });

  it("renders nothing in desk mode — the desk has no crew", () => {
    render(
      <UIProvider>
        <ModeProbe />
        <CrewToken units={UNITS} />
      </UIProvider>,
    );
    expect(screen.getByTestId("mode-probe").getAttribute("data-mode")).toBe("desk");
    expect(screen.queryByTestId("crew-token")).toBeNull();
  });

  it("crew mode: one drone unit per subagent, its real task in the hover card", async () => {
    await renderAsCrew(<CrewToken units={UNITS} active />);
    const token = screen.getByTestId("crew-token");
    // A hovering drone per unit, active while the run executes.
    const drones = token.querySelectorAll("svg[data-active='true']");
    expect(drones.length).toBe(2);
    expect(token.textContent).toContain("scout");
    expect(token.textContent).toContain("worker");
    // The hover card carries the REAL task from the spawn envelope.
    expect(token.textContent).toContain("Map every caller of refreshToken() across the gateway");
    expect(token.textContent).toContain("Patch the single-flight around the refresh promise");
  });

  it("an idle run parks the drones (no hover flame)", async () => {
    await renderAsCrew(<CrewToken units={UNITS} />);
    expect(screen.getByTestId("crew-token").querySelectorAll("svg[data-active='false']").length).toBe(2);
  });

  it("more than four units overflow into a +N count", async () => {
    const six: CrewUnit[] = ["a", "b", "c", "d", "e", "f"].map((n) => ({ name: n, task: `task ${n}` }));
    await renderAsCrew(<CrewToken units={six} />);
    const token = screen.getByTestId("crew-token");
    expect(token.querySelectorAll("svg").length).toBe(4); // MAX_UNITS
    expect(token.textContent).toContain("+2");
    expect(token.textContent).not.toContain("task e");
  });
});
