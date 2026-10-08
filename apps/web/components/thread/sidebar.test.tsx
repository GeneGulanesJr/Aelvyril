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

  it("kill all requires a second confirming click (#84)", () => {
    const onKillAll = vi.fn();
    render(
      <ThreadSidebar
        threads={threads}
        activeId="t1"
        onSelect={() => {}}
        onCreate={() => {}}
        onKillAll={onKillAll}
      />,
    );
    fireEvent.click(screen.getByTestId("kill-all-button"));
    expect(onKillAll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("kill-all-button"));
    expect(onKillAll).toHaveBeenCalledTimes(1);
  });

  it("kill all is hidden when the callback is absent (#84)", () => {
    render(<ThreadSidebar threads={threads} activeId="t1" onSelect={() => {}} onCreate={() => {}} />);
    expect(screen.queryByTestId("kill-all-button")).toBeNull();
  });

  it("renders the queued status pill (#83)", () => {
    render(
      <ThreadSidebar
        threads={[{ ...threads[0]!, status: "queued" as const }]}
        activeId="t1"
        onSelect={() => {}}
        onCreate={() => {}}
      />,
    );
    const pill = screen.getByTestId("status-pill");
    expect(pill.textContent).toBe("queued");
    // queued rides the caution aspect (STATUS_META.queued.textClass).
    expect(pill.className).toContain("text-caution");
  });

  it("list lives in its own scroll container when the board is long", () => {
    const many: Thread[] = Array.from({ length: 40 }, (_, i) => ({
      ...threads[0]!,
      id: `bulk-${i}`,
      title: `bulk job ${i}`,
    }));
    render(<ThreadSidebar threads={many} activeId={null} onSelect={() => {}} onCreate={() => {}} />);
    const list = screen.getByTestId("thread-list");
    expect(list.className).toContain("overflow-y-auto");
    expect(screen.getAllByTestId("status-pill")).toHaveLength(40);
  });

  it("a blocked thread shows the needs-you lamp under the Needs you band", () => {
    render(
      <ThreadSidebar
        threads={[{ ...threads[0]!, state: "blocked" as const, status: "running" as const }]}
        activeId="t1"
        onSelect={() => {}}
        onCreate={() => {}}
      />,
    );
    const lamp = screen.getByTestId("thread-t1").querySelector(".bg-needsyou");
    expect(lamp).toBeTruthy();
    expect(lamp!.className).toContain("animate-lamp-pulse");
    expect(screen.getByText("Needs you")).toBeTruthy();
  });

  it("groups by lifecycle: reviewed threads land under Closed", () => {
    render(
      <ThreadSidebar
        threads={[
          { ...threads[0]!, id: "t3", title: "still running", status: "running" as const },
          threads[1]!, // merged
          { ...threads[0]!, status: "reviewed" as const },
        ]}
        activeId={null}
        onSelect={() => {}}
        onCreate={() => {}}
      />,
    );
    const closed = screen.getByText("Closed").closest("section");
    expect(closed).toBeTruthy();
    expect(closed!.querySelector('[data-testid="thread-t1"]')).toBeTruthy();
    expect(closed!.querySelector('[data-testid="thread-t2"]')).toBeTruthy();
    expect(closed!.querySelector('[data-testid="thread-t3"]')).toBeNull();
  });
});
