import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ThreadHeader } from "./header.js";
import type { Thread } from "@aelvyril/shared";

const thread: Thread = {
  id: "t1",
  title: "add RBAC",
  workspace: null,
  state: "idle",
  createdAt: "2026-09-23T00:00:00.000Z",
  status: "spec'ing",
  specDraft: null,
  specQuestions: [],
  specAnswers: {},
};

describe("ThreadHeader", () => {
  beforeEach(() => cleanup());

  it("renders title + status pill", () => {
    render(<ThreadHeader thread={thread} onRename={() => {}} onAbandon={() => {}} />);
    expect(screen.getByTestId("thread-title").textContent).toBe("add RBAC");
    expect(screen.getByTestId("thread-status").textContent).toBe("spec'ing");
  });

  it("falls back to untitled when title is null", () => {
    render(<ThreadHeader thread={{ ...thread, title: null }} onRename={() => {}} onAbandon={() => {}} />);
    expect(screen.getByTestId("thread-title").textContent).toBe("untitled");
  });

  it("renames via inline input on submit", () => {
    const onRename = vi.fn();
    render(<ThreadHeader thread={thread} onRename={onRename} onAbandon={() => {}} />);
    fireEvent.click(screen.getByTestId("rename-button"));
    const input = screen.getByTestId("rename-input");
    fireEvent.change(input, { target: { value: "better title" } });
    fireEvent.submit((input as HTMLInputElement).form!);
    expect(onRename).toHaveBeenCalledWith("better title");
  });

  it("abandon calls back", () => {
    const onAbandon = vi.fn();
    render(<ThreadHeader thread={thread} onRename={() => {}} onAbandon={onAbandon} />);
    fireEvent.click(screen.getByTestId("abandon-button"));
    expect(onAbandon).toHaveBeenCalled();
  });
});
