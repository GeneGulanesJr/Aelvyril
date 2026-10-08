import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { UIProvider, useUiMode } from "./ui-mode.js";

function Probe() {
  const { mode, setMode } = useUiMode();
  return (
    <div>
      <span data-testid="probe-mode">{mode}</span>
      <button data-testid="probe-set-crew" onClick={() => setMode("crew")}>crew</button>
      <button data-testid="probe-set-desk" onClick={() => setMode("desk")}>desk</button>
    </div>
  );
}

const renderProbe = () =>
  render(
    <UIProvider>
      <Probe />
    </UIProvider>,
  );

describe("UIProvider", () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("defaults to desk when nothing is stored", () => {
    renderProbe();
    expect(screen.getByTestId("probe-mode").textContent).toBe("desk");
  });

  it("adopts a persisted crew mode on mount", () => {
    window.localStorage.setItem("aelvyril.ui-mode", "crew");
    renderProbe();
    expect(screen.getByTestId("probe-mode").textContent).toBe("crew");
  });

  it("falls back to desk on invalid stored values", () => {
    window.localStorage.setItem("aelvyril.ui-mode", "spaceship");
    renderProbe();
    expect(screen.getByTestId("probe-mode").textContent).toBe("desk");
  });

  it("setMode writes through to localStorage", () => {
    renderProbe();
    fireEvent.click(screen.getByTestId("probe-set-crew"));
    expect(screen.getByTestId("probe-mode").textContent).toBe("crew");
    expect(window.localStorage.getItem("aelvyril.ui-mode")).toBe("crew");
    fireEvent.click(screen.getByTestId("probe-set-desk"));
    expect(screen.getByTestId("probe-mode").textContent).toBe("desk");
    expect(window.localStorage.getItem("aelvyril.ui-mode")).toBe("desk");
  });

  it("useUiMode throws outside a provider (loud failure by design)", () => {
    expect(() => render(<Probe />)).toThrow(/UIProvider/);
  });
});
