import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { OutputTabs } from "./output-tabs.js";
import type { SpecDraft } from "@aelvyril/shared";
import type { TimelineItem } from "../../lib/use-thread.js";

const t0 = "2026-10-08T10:00:00.000Z";

const draft: SpecDraft = {
  goal: "Fix the login redirect loop",
  filesAffected: ["src/auth.ts", "src/middleware.ts"],
  plan: ["Reproduce the loop", "Patch the guard", "Add a regression test"],
  risks: ["Middleware ordering differs across deploys"],
  questions: [],
  answers: {},
};

const timeline: TimelineItem[] = [
  { kind: "user", id: "u1", ts: t0, text: "fix the login redirect" },
  { kind: "narration", id: "n1", ts: t0, text: "Reading the auth guard.", live: true },
];

function setup(overrides: Partial<Parameters<typeof OutputTabs>[0]> = {}) {
  return render(
    <OutputTabs
      plan={["step1", "step2"]}
      draft={null}
      trace={["hello", "world"]}
      timeline={[]}
      diff={[{ path: "a.ts", patch: "@@ -1,2 +1,3 @@\n-old\n+new\n context" }]}
      streamLive={false}
      {...overrides}
    />,
  );
}

describe("OutputTabs", () => {
  beforeEach(() => cleanup());

  it("switches between Plan / Trace / Diff tabs", () => {
    setup();
    fireEvent.click(screen.getByTestId("tab-plan"));
    expect(screen.getByText("step1").textContent).toBe("step1");
    fireEvent.click(screen.getByTestId("tab-trace"));
    expect(screen.getByText("hello").textContent).toBe("hello");
    fireEvent.click(screen.getByTestId("tab-diff"));
    expect(screen.getByText("a.ts").textContent).toBe("a.ts");
  });

  it("opens on the diff when one exists — the artifact leads", () => {
    setup();
    expect(screen.getByTestId("tab-diff").getAttribute("data-active")).toBe("true");
  });

  it("plan is the default when there is nothing to review or watch", () => {
    setup({ diff: [] });
    expect(screen.getByTestId("tab-plan").getAttribute("data-active")).toBe("true");
  });

  it("a live timeline with no plan opens the trace", () => {
    setup({ diff: [], plan: [], timeline });
    expect(screen.getByTestId("tab-trace").getAttribute("data-active")).toBe("true");
  });

  it("renders diff lines color-coded by prefix with aspect tokens", () => {
    setup();
    fireEvent.click(screen.getByTestId("tab-diff"));
    // "@@ -1,2 +1,3 @@" → route (hunk header)
    expect(screen.getByTestId("diff-line-0").className).toContain("text-route");
    // "-old" → danger; "+new" → go; " context" → faint
    expect(screen.getByTestId("diff-line-1").className).toContain("text-danger");
    expect(screen.getByTestId("diff-line-1").className).toContain("bg-danger/10");
    expect(screen.getByTestId("diff-line-2").className).toContain("text-go");
    expect(screen.getByTestId("diff-line-2").className).toContain("bg-go/10");
    expect(screen.getByTestId("diff-line-3").className).toContain("text-ink-faint");
  });

  it("numbers diff lines with a global running index across files", () => {
    setup({
      diff: [
        { path: "a.ts", patch: "@@\n+a\n-b" },
        { path: "b.ts", patch: "x\n+y" },
      ],
    });
    fireEvent.click(screen.getByTestId("tab-diff"));
    const lists = screen.getAllByTestId("diff-list");
    expect(lists).toHaveLength(2);
    expect(lists[0]!.querySelector('[data-testid="diff-line-0"]')!.textContent).toContain("@@");
    expect(lists[0]!.querySelector('[data-testid="diff-line-2"]')!.textContent).toContain("-b");
    // Index continues into the second file instead of restarting at 0.
    expect(lists[1]!.querySelector('[data-testid="diff-line-3"]')!.textContent).toContain("x");
    expect(lists[1]!.querySelector('[data-testid="diff-line-4"]')!.textContent).toContain("+y");
    expect(lists[1]!.querySelector('[data-testid="diff-line-4"]')!.className).toContain("text-go");
    // First file card open by default, the rest closed.
    expect(screen.getByText("a.ts").closest("details")!.hasAttribute("open")).toBe(true);
    expect(screen.getByText("b.ts").closest("details")!.hasAttribute("open")).toBe(false);
  });

  it("renders +N/-M stats per file", () => {
    setup();
    fireEvent.click(screen.getByTestId("tab-diff"));
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("-1")).toBeTruthy();
  });

  it("copies a file patch via the clipboard and swaps in a check", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    setup();
    fireEvent.click(screen.getByTestId("tab-diff"));
    fireEvent.click(screen.getByTestId("copy-patch-0"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("@@ -1,2 +1,3 @@\n-old\n+new\n context"));
    const check = screen.getByTestId("copy-patch-0").querySelector("svg.lucide-check");
    expect(check).toBeTruthy();
    expect(check!.getAttribute("class")).toContain("text-go");
  });

  it("a copy click must not fold the file card", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    setup();
    fireEvent.click(screen.getByTestId("tab-diff"));
    fireEvent.click(screen.getByTestId("copy-patch-0"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.getByText("a.ts").closest("details")!.hasAttribute("open")).toBe(true);
    expect(screen.getByTestId("diff-list")).toBeTruthy();
  });

  it("empty diff teaches where the review lands", () => {
    setup({ diff: [] });
    fireEvent.click(screen.getByTestId("tab-diff"));
    expect(screen.getByText("No diff yet.")).toBeTruthy();
    expect(screen.getByText("When the agent finishes, the changes to review land here.")).toBeTruthy();
  });

  it("routes the trace pane to TraceTimeline when a timeline exists", () => {
    setup({ timeline });
    fireEvent.click(screen.getByTestId("tab-trace"));
    // TraceTimeline owns the trace-list testid now; the legacy raw lines are gone.
    expect(screen.getByTestId("trace-list")).toBeTruthy();
    expect(screen.queryByText("hello")).toBeNull();
    expect(screen.getByTestId("tl-user-0").textContent).toContain("fix the login redirect");
  });

  it("shows the stream caret on live narration only while streaming", () => {
    const { container } = setup({ timeline, streamLive: true });
    fireEvent.click(screen.getByTestId("tab-trace"));
    expect(container.querySelector(".animate-stream-caret")).toBeTruthy();
    cleanup();
    const sealed = setup({ timeline, streamLive: false });
    fireEvent.click(screen.getByTestId("tab-trace"));
    expect(sealed.container.querySelector(".animate-stream-caret")).toBeNull();
  });

  it("falls back to the raw trace lines (and its empty copy) without a timeline", () => {
    setup({ timeline: [] });
    fireEvent.click(screen.getByTestId("tab-trace"));
    expect(screen.getByText("hello")).toBeTruthy();
    cleanup();
    setup({ timeline: [], trace: [] });
    fireEvent.click(screen.getByTestId("tab-trace"));
    expect(screen.getByText("No output yet.")).toBeTruthy();
  });

  it("shows the timeline item count next to the Trace label", () => {
    setup({ timeline });
    expect(screen.getByTestId("tab-trace").textContent).toContain("2");
    cleanup();
    setup({ timeline: [] });
    expect(screen.getByTestId("tab-trace").textContent).toBe("Trace");
  });

  it("renders the spec draft as the plan of record", () => {
    setup({ draft, diff: [] });
    expect(screen.getByText("Fix the login redirect loop")).toBeTruthy();
    expect(screen.getByTestId("plan-list").textContent).toContain("Reproduce the loop");
    expect(screen.getByText("01")).toBeTruthy();
    expect(screen.getByText("src/auth.ts").className).toContain("text-route");
    expect(screen.getByText("Middleware ordering differs across deploys")).toBeTruthy();
  });

  it("empty plan teaches the interview flow", () => {
    setup({ plan: [], diff: [] });
    expect(screen.getByText("No plan yet.")).toBeTruthy();
    expect(screen.getByText(/interviews you first/)).toBeTruthy();
  });
});
