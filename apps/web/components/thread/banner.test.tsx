import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Banners } from "./banner.js";

describe("Banners", () => {
  beforeEach(() => cleanup());

  it("renders the degraded banner (persistent) while degraded", () => {
    render(<Banners degraded={true} error={null} onDismissError={() => {}} />);
    const b = screen.getByTestId("degraded-banner");
    expect(b.className).toContain("bg-[#e3b341]");
    expect(b.textContent).toContain("respawn");
  });

  it("hides the degraded banner when not degraded", () => {
    render(<Banners degraded={false} error={null} onDismissError={() => {}} />);
    expect(screen.queryByTestId("degraded-banner")).toBeNull();
  });

  it("renders the error banner with a working dismiss", () => {
    const onDismissError = vi.fn();
    render(<Banners degraded={false} error="boom" onDismissError={onDismissError} />);
    const b = screen.getByTestId("error-banner");
    expect(b.className).toContain("bg-[#f85149]");
    expect(b.textContent).toContain("boom");
    fireEvent.click(screen.getByTestId("dismiss-error"));
    expect(onDismissError).toHaveBeenCalled();
  });
});
