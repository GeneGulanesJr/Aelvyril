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

  it("renders the usage pill when usage exists, nothing when null (#84)", () => {
    const usage = { tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 }, cost: 0.0042 };
    const { unmount } = render(
      <ThreadHeader thread={thread} usage={usage} onRename={() => {}} onAbandon={() => {}} />,
    );
    expect(screen.getByTestId("thread-usage").textContent).toBe("$0.0042 · 165 tok");
    unmount();
    render(<ThreadHeader thread={thread} usage={null} onRename={() => {}} onAbandon={() => {}} />);
    expect(screen.queryByTestId("thread-usage")).toBeNull();
  });

  it("liveStatus wins over the stale mount-time status (#83)", () => {
    const { unmount } = render(
      <ThreadHeader thread={thread} liveStatus="running" onRename={() => {}} onAbandon={() => {}} />,
    );
    expect(screen.getByTestId("thread-status").textContent).toBe("running");
    unmount();
    // No live status yet → the mount-time snapshot.
    render(<ThreadHeader thread={thread} liveStatus={null} onRename={() => {}} onAbandon={() => {}} />);
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

  it("delete requires a second confirming click (no window.confirm)", () => {
    const onDelete = vi.fn();
    render(<ThreadHeader thread={thread} onRename={() => {}} onAbandon={() => {}} onDelete={onDelete} />);
    fireEvent.click(screen.getByTestId("delete-button"));
    expect(onDelete).not.toHaveBeenCalled();
    // Still armed: a second click confirms.
    fireEvent.click(screen.getByTestId("delete-button"));
    expect(onDelete).toHaveBeenCalled();
  });

  it("armed delete can be cancelled", () => {
    const onDelete = vi.fn();
    render(<ThreadHeader thread={thread} onRename={() => {}} onAbandon={() => {}} onDelete={onDelete} />);
    fireEvent.click(screen.getByTestId("delete-button"));
    fireEvent.click(screen.getByTestId("delete-cancel"));
    fireEvent.click(screen.getByTestId("delete-button"));
    expect(onDelete).not.toHaveBeenCalled();
  });
});
