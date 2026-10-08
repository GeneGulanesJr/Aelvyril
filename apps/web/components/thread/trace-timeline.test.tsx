import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { TraceTimeline } from "./trace-timeline.js";
import type { TimelineItem } from "../../lib/use-thread.js";

const t0 = "2026-10-08T10:00:00.000Z";
const t1 = "2026-10-08T10:00:01.500Z";
const t2 = "2026-10-08T10:00:01.750Z";

const full: TimelineItem[] = [
  { kind: "user", id: "u1", ts: t0, text: "fix the login redirect" },
  { kind: "narration", id: "n1", ts: t0, text: "Reading the auth guard.", live: true },
  { kind: "narration", id: "n2", ts: t0, text: "Sealed narration.", live: false },
  { kind: "tool", id: "c1", ts: t0, name: "read_file", args: '{"path":"src/auth.ts"}' },
  {
    kind: "tool",
    id: "c2",
    ts: t0,
    name: "grep",
    args: '{"q":"redirect"}',
    result: { isError: false, ts: t1 },
  },
  {
    kind: "tool",
    id: "c3",
    ts: t1,
    name: "run_tests",
    args: '{"cmd":"pnpm test"}',
    result: { isError: true, ts: t2 },
  },
  {
    kind: "subagents",
    id: "s1",
    ts: t2,
    mode: "parallel",
    agents: [
      { agent: "scout", task: "map the callers" },
      { agent: "fixer", task: "patch the guard" },
    ],
  },
  { kind: "sandbox", id: "sb1", ts: t2, profile: "strict", sandboxId: "sbx-1" },
  { kind: "promote", id: "pr1", ts: t2, sandboxId: "sbx-1", paths: ["src/auth.ts"] },
  { kind: "verdict", id: "v1", ts: t2, tool: "laya_review", verdict: { safe: true } },
  { kind: "dialog", id: "d1", ts: t2, title: "Irreversible action", action: "blocked" },
  { kind: "dialog", id: "d2", ts: t2, title: "Auto-answered dialog", action: "auto_cancelled" },
];

/** noUncheckedIndexedAccess makes full[i] `T | undefined` — the fixtures are static. */
const item = (i: number): TimelineItem => full[i]!;

function row(id: string): HTMLElement {
  return screen.getByTestId(id);
}

/** lucide renders one svg per icon with a deterministic class. SVG
 *  className is an SVGAnimatedString — read the attribute instead. */
function iconIn(row: HTMLElement, name: string): SVGSVGElement | null {
  return row.querySelector(`svg.lucide-${name}`);
}

function iconClass(row: HTMLElement, name: string): string | null {
  return iconIn(row, name)?.getAttribute("class") ?? null;
}

describe("TraceTimeline", () => {
  beforeEach(() => cleanup());

  it("renders every row with its stable tl-<kind>-<index> testid", () => {
    render(<TraceTimeline items={full} streamLive={false} />);
    expect(row("tl-user-0").textContent).toContain("fix the login redirect");
    expect(row("tl-narration-1").textContent).toContain("Reading the auth guard.");
    expect(row("tl-narration-2").textContent).toContain("Sealed narration.");
    expect(row("tl-tool-3").textContent).toContain("read_file");
    expect(row("tl-tool-4").textContent).toContain("grep");
    expect(row("tl-tool-5").textContent).toContain("run_tests");
    expect(row("tl-subagents-6")).toBeTruthy();
    expect(row("tl-sandbox-7").textContent).toContain("strict");
    expect(row("tl-promote-8").textContent).toContain("sbx-1");
    expect(row("tl-verdict-9").textContent).toContain("laya_review");
    expect(row("tl-dialog-10").textContent).toContain("Irreversible action");
    expect(row("tl-dialog-11").textContent).toContain("Auto-answered dialog");
  });

  it("user rows carry the route corner icon", () => {
    render(<TraceTimeline items={[item(0)]} streamLive={false} />);
    expect(iconClass(row("tl-user-0"), "corner-down-right")).toContain("text-route");
  });

  it("live narration shows the stream caret only when streaming; sealed narration never does", () => {
    const { container } = render(<TraceTimeline items={[item(1), item(2)]} streamLive={true} />);
    expect(container.querySelector(".animate-stream-caret")).toBeTruthy();
    cleanup();
    const sealed = render(<TraceTimeline items={[item(1), item(2)]} streamLive={false} />);
    expect(sealed.container.querySelector(".animate-stream-caret")).toBeNull();
  });

  it("pending tools spin, without a result aspect or duration", () => {
    render(<TraceTimeline items={[item(3)]} streamLive={false} />);
    const r = row("tl-tool-0");
    expect(iconClass(r, "loader-2")).toContain("animate-spin");
    expect(iconIn(r, "check")).toBeNull();
    expect(iconIn(r, "x")).toBeNull();
  });

  it("paired ok tool shows the go check and its duration", () => {
    render(<TraceTimeline items={[item(4)]} streamLive={false} />);
    const r = row("tl-tool-0");
    expect(iconClass(r, "check")).toContain("text-go");
    expect(r.textContent).toContain("1.5s");
  });

  it("paired error tool shows the danger cross and its duration", () => {
    render(<TraceTimeline items={[item(5)]} streamLive={false} />);
    const r = row("tl-tool-0");
    expect(iconClass(r, "x")).toContain("text-danger");
    expect(r.textContent).toContain("250ms");
  });

  it("subagents list the team mono-joined with a mode chip and per-agent tasks", () => {
    render(<TraceTimeline items={[item(6)]} streamLive={false} />);
    const r = row("tl-subagents-0");
    expect(iconClass(r, "users")).toContain("text-caution");
    expect(r.textContent).toContain("scout · fixer");
    expect(r.textContent).toContain("parallel");
    expect(r.textContent).toContain("map the callers");
    expect(r.textContent).toContain("patch the guard");
  });

  it("sandbox and promote rows render profile/sandboxId/paths", () => {
    render(<TraceTimeline items={[item(7), item(8)]} streamLive={false} />);
    expect(row("tl-sandbox-0").textContent).toContain("strict");
    expect(row("tl-sandbox-0").textContent).toContain("sbx-1");
    expect(row("tl-promote-1").textContent).toContain("src/auth.ts");
  });

  it("verdict rows expose the verdict JSON inside a details", () => {
    render(<TraceTimeline items={[item(9)]} streamLive={false} />);
    const r = row("tl-verdict-0");
    expect(iconClass(r, "scale")).toContain("text-route");
    expect(r.querySelector("details")?.textContent).toContain('"safe": true');
  });

  it("dialog rows go danger when blocked, faint when auto-cancelled", () => {
    render(<TraceTimeline items={[item(10), item(11)]} streamLive={false} />);
    expect(iconClass(row("tl-dialog-0"), "message-square-warning")).toContain("text-danger");
    expect(iconClass(row("tl-dialog-1"), "message-square-warning")).toContain("text-ink-faint");
  });

  it("stays pinned (no pill) while at the bottom; scrolling up releases the pin", () => {
    const { container } = render(<TraceTimeline items={full} streamLive={false} />);
    const scroller = container.querySelector<HTMLElement>('[data-testid="trace-scroll"]')!;
    Object.defineProperty(scroller, "scrollHeight", { value: 800, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 200, configurable: true });
    expect(screen.queryByTestId("jump-to-now")).toBeNull();
    scroller.scrollTop = 0; // 600px from the bottom — reading history
    fireEvent.scroll(scroller);
    expect(screen.getByTestId("jump-to-now")).toBeTruthy();
  });

  it("the jump-to-now pill scrolls back to the bottom and re-pins", () => {
    const { container } = render(<TraceTimeline items={full} streamLive={false} />);
    const scroller = container.querySelector<HTMLElement>('[data-testid="trace-scroll"]')!;
    Object.defineProperty(scroller, "scrollHeight", { value: 800, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 200, configurable: true });
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    fireEvent.click(screen.getByTestId("jump-to-now"));
    expect(scroller.scrollTop).toBe(800);
    expect(screen.queryByTestId("jump-to-now")).toBeNull();
  });

  it("scrolling back near the bottom re-pins without the pill", () => {
    const { container } = render(<TraceTimeline items={full} streamLive={false} />);
    const scroller = container.querySelector<HTMLElement>('[data-testid="trace-scroll"]')!;
    Object.defineProperty(scroller, "scrollHeight", { value: 800, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 200, configurable: true });
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    expect(screen.getByTestId("jump-to-now")).toBeTruthy();
    scroller.scrollTop = 750; // within 80px of the bottom
    fireEvent.scroll(scroller);
    expect(screen.queryByTestId("jump-to-now")).toBeNull();
  });
});
