import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ThreadInput } from "./input.js";

describe("ThreadInput", () => {
  beforeEach(() => cleanup());

  it("renders Ask and Ask+spec buttons; submits via callback", () => {
    const ask = vi.fn();
    render(<ThreadInput onAsk={ask} disabled={false} />);
    fireEvent.change(screen.getByTestId("thread-input"), { target: { value: "add RBAC" } });
    fireEvent.click(screen.getByTestId("ask-button"));
    expect(ask).toHaveBeenCalledWith("add RBAC", "auto");
  });

  it("Ask+spec submits with force mode", () => {
    const ask = vi.fn();
    render(<ThreadInput onAsk={ask} disabled={false} />);
    fireEvent.change(screen.getByTestId("thread-input"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("ask-spec-button"));
    expect(ask).toHaveBeenCalledWith("x", "force");
  });

  it("empty input disables both buttons; disabled prop disables everything", () => {
    const ask = vi.fn();
    render(<ThreadInput onAsk={ask} disabled={true} />);
    expect((screen.getByTestId("ask-button") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("ask-spec-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Stop appears only while waiting and calls onStop", () => {
    const onStop = vi.fn();
    const { rerender } = render(<ThreadInput onAsk={() => {}} disabled={false} />);
    expect(screen.queryByTestId("stop-button")).toBeNull();
    rerender(<ThreadInput onAsk={() => {}} disabled={false} waiting={true} onStop={onStop} />);
    fireEvent.click(screen.getByTestId("stop-button"));
    expect(onStop).toHaveBeenCalled();
  });

  it("submitting prop disables both send buttons", () => {
    render(<ThreadInput onAsk={() => {}} disabled={false} submitting={true} />);
    expect((screen.getByTestId("ask-button") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("ask-spec-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("clears text only after a promise-returning onAsk resolves", async () => {
    let resolve!: () => void;
    const ask = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    render(<ThreadInput onAsk={ask} disabled={false} />);
    fireEvent.change(screen.getByTestId("thread-input"), { target: { value: "persist me" } });
    fireEvent.click(screen.getByTestId("ask-button"));
    // Still in flight — the text must survive until success.
    expect((screen.getByTestId("thread-input") as HTMLTextAreaElement).value).toBe("persist me");
    resolve();
    await waitFor(() =>
      expect((screen.getByTestId("thread-input") as HTMLTextAreaElement).value).toBe(""),
    );
  });

  it("keeps the text when a promise-returning onAsk rejects (failed create)", async () => {
    const ask = vi.fn(() => Promise.reject(new Error("create thread failed: 500")));
    render(<ThreadInput onAsk={ask} disabled={false} />);
    fireEvent.change(screen.getByTestId("thread-input"), { target: { value: "keep me" } });
    fireEvent.click(screen.getByTestId("ask-button"));
    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect((screen.getByTestId("thread-input") as HTMLTextAreaElement).value).toBe("keep me");
  });
});
