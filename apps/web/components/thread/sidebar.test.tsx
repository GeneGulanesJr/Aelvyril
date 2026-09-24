import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ThreadSidebar } from "./sidebar.js";
import type { Thread } from "@aelvyril/shared";

const threads: Thread[] = [
  { id: "t1", title: "add RBAC", workspace: null, state: "idle", createdAt: "2026-09-23T00:00:00.000Z", status: "spec'ing", specDraft: null, specQuestions: [], specAnswers: {} },
  { id: "t2", title: "fix typo", workspace: null, state: "idle", createdAt: "2026-09-22T00:00:00.000Z", status: "merged", specDraft: null, specQuestions: [], specAnswers: {} },
];

describe("ThreadSidebar", () => {
  beforeEach(() => cleanup());

  it("renders threads with status pills", () => {
    render(<ThreadSidebar threads={threads} activeId="t1" onSelect={() => {}} onCreate={() => {}} />);
    expect(screen.getByText("add RBAC").textContent).toBe("add RBAC");
    expect(screen.getByText("fix typo").textContent).toBe("fix typo");
    expect(screen.getAllByTestId("status-pill")[0]!.textContent).toBe("spec'ing");
  });

  it("select + create round-trip through callbacks", () => {
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    render(<ThreadSidebar threads={threads} activeId="t1" onSelect={onSelect} onCreate={onCreate} />);
    screen.getByTestId("thread-t2").click();
    expect(onSelect).toHaveBeenCalledWith("t2");
    screen.getByTestId("new-thread").click();
    expect(onCreate).toHaveBeenCalled();
  });

  it("falls back to the id when the title is null", () => {
    render(
      <ThreadSidebar
        threads={[{ ...threads[0]!, title: null }]}
        activeId={null}
        onSelect={() => {}}
        onCreate={() => {}}
      />,
    );
    expect(screen.getByTestId("thread-t1").textContent).toContain("t1");
  });

  it("search filters threads by case-insensitive title substring", () => {
    render(<ThreadSidebar threads={threads} activeId="t1" onSelect={() => {}} onCreate={() => {}} />);
    fireEvent.change(screen.getByTestId("thread-search"), { target: { value: "RBAC" } });
    expect(screen.getByTestId("thread-t1")).toBeTruthy();
    expect(screen.queryByTestId("thread-t2")).toBeNull();
    fireEvent.change(screen.getByTestId("thread-search"), { target: { value: "typo" } });
    expect(screen.queryByTestId("thread-t1")).toBeNull();
    expect(screen.getByTestId("thread-t2")).toBeTruthy();
    // Clearing restores the full list.
    fireEvent.change(screen.getByTestId("thread-search"), { target: { value: "" } });
    expect(screen.getByTestId("thread-t1")).toBeTruthy();
    expect(screen.getByTestId("thread-t2")).toBeTruthy();
  });

  it("search matches by id too (untitled threads stay findable)", () => {
    render(
      <ThreadSidebar
        threads={[{ ...threads[0]!, title: null }]}
        activeId={null}
        onSelect={() => {}}
        onCreate={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId("thread-search"), { target: { value: "T1" } });
    expect(screen.getByTestId("thread-t1")).toBeTruthy();
  });
});
