import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Banners } from "./banner.js";

describe("Banners", () => {
  beforeEach(() => cleanup());

  it("renders the degraded banner (persistent) while degraded", () => {
    render(<Banners degraded={true} blocked={null} error={null} onDismissError={() => {}} />);
    const b = screen.getByTestId("degraded-banner");
    expect(b.className).toContain("bg-[#e3b341]");
    expect(b.textContent).toContain("respawn");
  });

  it("hides the degraded banner when not degraded", () => {
    render(<Banners degraded={false} blocked={null} error={null} onDismissError={() => {}} />);
    expect(screen.queryByTestId("degraded-banner")).toBeNull();
  });

  it("renders the error banner with a working dismiss", () => {
    const onDismissError = vi.fn();
    render(<Banners degraded={false} blocked={null} error="boom" onDismissError={onDismissError} />);
    const b = screen.getByTestId("error-banner");
    expect(b.className).toContain("bg-[#f85149]");
    expect(b.textContent).toContain("boom");
    fireEvent.click(screen.getByTestId("dismiss-error"));
    expect(onDismissError).toHaveBeenCalled();
  });

  it("renders the blocked banner with a reason-specific message (#84)", () => {
    render(<Banners degraded={false} blocked="capped" error={null} onDismissError={() => {}} />);
    const b = screen.getByTestId("blocked-banner");
    expect(b.textContent).toContain("Needs you");
    expect(b.textContent).toContain("budget cap");
    expect(b.textContent).toContain("GATEWAY_MAX_THREAD_COST_USD");
  });

  it("blocked banner messages vary by reason and hide when null (#84)", () => {
    cleanup();
    render(<Banners degraded={false} blocked="dialog" error={null} onDismissError={() => {}} />);
    expect(screen.getByTestId("blocked-banner").textContent).toContain("blocking dialog");
    cleanup();
    render(<Banners degraded={false} blocked="question" error={null} onDismissError={() => {}} />);
    expect(screen.getByTestId("blocked-banner").textContent).toContain("asked a question");
    cleanup();
    render(<Banners degraded={false} blocked={null} error={null} onDismissError={() => {}} />);
    expect(screen.queryByTestId("blocked-banner")).toBeNull();
  });
});
