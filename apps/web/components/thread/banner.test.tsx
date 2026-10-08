import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Banners } from "./banner.js";

describe("Banners", () => {
  beforeEach(() => cleanup());

  it("renders the degraded banner (persistent) while degraded", () => {
    render(<Banners degraded={true} blocked={null} error={null} onDismissError={() => {}} />);
    const b = screen.getByTestId("degraded-banner");
    expect(b.className).toContain("bg-caution/15");
    expect(b.className).toContain("text-caution");
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
    expect(b.className).toContain("bg-danger/15");
    expect(b.className).toContain("text-danger");
    expect(b.textContent).toContain("boom");
    fireEvent.click(screen.getByTestId("dismiss-error"));
    expect(onDismissError).toHaveBeenCalled();
  });

  it("renders the blocked banner as the reserved needs-you band (#84)", () => {
    render(<Banners degraded={false} blocked="capped" error={null} onDismissError={() => {}} />);
    const b = screen.getByTestId("blocked-banner");
    expect(b.className).toContain("bg-needsyou");
    expect(b.className).toContain("text-needsyou-ink");
    expect(b.getAttribute("role")).toBe("alert");
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

  it("the gated reason tells the user what stopped and how to continue (#81)", () => {
    render(<Banners degraded={false} blocked="gated" error={null} onDismissError={() => {}} />);
    const b = screen.getByTestId("blocked-banner");
    expect(b.textContent).toContain("irreversible action");
    expect(b.textContent).toContain("approve");
  });

  it("renders at most one band — blocked outranks error, error outranks degraded", () => {
    render(<Banners degraded={true} blocked="capped" error="boom" onDismissError={() => {}} />);
    expect(screen.getByTestId("blocked-banner")).toBeDefined();
    expect(screen.queryByTestId("error-banner")).toBeNull();
    expect(screen.queryByTestId("degraded-banner")).toBeNull();
    cleanup();
    render(<Banners degraded={true} blocked={null} error="boom" onDismissError={() => {}} />);
    expect(screen.getByTestId("error-banner")).toBeDefined();
    expect(screen.queryByTestId("degraded-banner")).toBeNull();
  });

  it("shows Retry turn only when onRetry is passed, and fires it", () => {
    const onRetry = vi.fn();
    const { unmount } = render(
      <Banners degraded={false} blocked={null} error="boom" onDismissError={() => {}} />,
    );
    expect(screen.queryByTestId("retry-error")).toBeNull();
    unmount();
    render(
      <Banners degraded={false} blocked={null} error="boom" onDismissError={() => {}} onRetry={onRetry} />,
    );
    fireEvent.click(screen.getByTestId("retry-error"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("blocked action buttons render only with their handler and fire it", () => {
    const onGotoSpec = vi.fn();
    const onApprove = vi.fn();
    // No handler → capped/question/dialog render no action at all.
    const { unmount } = render(
      <Banners degraded={false} blocked="question" error={null} onDismissError={() => {}} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    unmount();
    render(
      <Banners degraded={false} blocked="question" error={null} onDismissError={() => {}} onGotoSpec={onGotoSpec} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Answer the questions" }));
    expect(onGotoSpec).toHaveBeenCalled();
    cleanup();
    render(
      <Banners degraded={false} blocked="gated" error={null} onDismissError={() => {}} onApprove={onApprove} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review & approve" }));
    expect(onApprove).toHaveBeenCalled();
  });
});
