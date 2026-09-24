import { cleanup, render, screen, fireEvent } from "@testing-library/react";
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
});
