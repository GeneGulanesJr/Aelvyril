import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SpecSession } from "./spec-session.js";
import type { SpecDraft, SpecQuestion } from "@aelvyril/shared";

const questions: SpecQuestion[] = [
  { id: "q1", prompt: "Which roles?", kind: "text" },
  { id: "q2", prompt: "Auth model?", kind: "select", options: ["existing", "new"] },
];

const emptyDraft: SpecDraft = {
  goal: "",
  filesAffected: [],
  plan: [],
  risks: [],
  questions: [],
  answers: {},
};

function setup(overrides: Partial<Parameters<typeof SpecSession>[0]> = {}) {
  const onSubmitAnswers = vi.fn();
  const onEditSpec = vi.fn();
  const onApprove = vi.fn();
  const onCancel = vi.fn();
  const props: Parameters<typeof SpecSession>[0] = {
    questions,
    draft: { ...emptyDraft, goal: "add RBAC" },
    status: "spec'ing",
    onSubmitAnswers,
    onEditSpec,
    onApprove,
    onCancel,
    ...overrides,
  };
  const view = render(<SpecSession {...props} />);
  return { view, props, onSubmitAnswers, onEditSpec, onApprove, onCancel };
}

const goalValue = () => (screen.getByTestId("spec-goal") as HTMLInputElement).value;

describe("SpecSession", () => {
  beforeEach(() => cleanup());
  afterEach(() => vi.useRealTimers());

  it("renders nothing outside spec'ing", () => {
    const { container } = render(<SpecSession questions={[]} draft={null} status="running" onSubmitAnswers={() => {}} onEditSpec={() => {}} onApprove={() => {}} onCancel={() => {}} />);
    expect(container.querySelector('[data-testid="spec-session"]')).toBeNull();
  });

  it("renders text + select questions and submits answers", () => {
    const { onSubmitAnswers } = setup();
    fireEvent.change(screen.getByTestId("q-q1"), { target: { value: "admin, editor" } });
    fireEvent.change(screen.getByTestId("q-q2"), { target: { value: "existing" } });
    fireEvent.click(screen.getByTestId("submit-answers"));
    expect(onSubmitAnswers).toHaveBeenCalledWith({ q1: "admin, editor", q2: "existing" });
  });

  it("disables submit until every question is answered", () => {
    setup();
    expect((screen.getByTestId("submit-answers") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("q-q1"), { target: { value: "admin" } });
    fireEvent.change(screen.getByTestId("q-q2"), { target: { value: "new" } });
    expect((screen.getByTestId("submit-answers") as HTMLButtonElement).disabled).toBe(false);
  });

  it("edits draft fields and approves / cancels (PATCH debounced, flushed on blur)", () => {
    vi.useFakeTimers();
    const { onEditSpec, onApprove, onCancel } = setup();
    fireEvent.change(screen.getByTestId("spec-goal"), { target: { value: "better goal" } });
    // Inside the debounce window nothing is sent yet.
    expect(onEditSpec).not.toHaveBeenCalled();
    fireEvent.blur(screen.getByTestId("spec-goal"));
    expect(onEditSpec).toHaveBeenCalledWith("goal", "better goal");
    fireEvent.change(screen.getByTestId("spec-files"), { target: { value: "a.ts, b.ts" } });
    fireEvent.blur(screen.getByTestId("spec-files"));
    expect(onEditSpec).toHaveBeenCalledWith("filesAffected", ["a.ts", "b.ts"]);
    fireEvent.click(screen.getByTestId("approve"));
    expect(onApprove).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("debounces the spec PATCH to one call per typing burst", () => {
    vi.useFakeTimers();
    const { onEditSpec } = setup();
    const goal = screen.getByTestId("spec-goal");
    fireEvent.change(goal, { target: { value: "b" } });
    fireEvent.change(goal, { target: { value: "be" } });
    fireEvent.change(goal, { target: { value: "bet" } });
    expect(onEditSpec).not.toHaveBeenCalled();
    vi.advanceTimersByTime(399);
    expect(onEditSpec).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onEditSpec).toHaveBeenCalledTimes(1);
    expect(onEditSpec).toHaveBeenCalledWith("goal", "bet");
  });

  it("keeps in-progress typing across a draft re-render (no keystroke loss)", () => {
    vi.useFakeTimers();
    const { view, props } = setup();
    fireEvent.change(screen.getByTestId("spec-goal"), { target: { value: "typed goal" } });
    // A new SSE envelope re-renders us with the (unchanged) server draft.
    view.rerender(<SpecSession {...props} draft={{ ...emptyDraft, goal: "add RBAC" }} />);
    expect(goalValue()).toBe("typed goal");
  });

  it("an incoming draft never clobbers the field being edited; after blur the next agent draft wins", () => {
    vi.useFakeTimers();
    const { view, props, onEditSpec } = setup();
    const goal = screen.getByTestId("spec-goal");
    fireEvent.focus(goal);
    fireEvent.change(goal, { target: { value: "mid-edit rewrite" } });
    // Agent re-draft arrives with a different goal while the user is mid-edit.
    view.rerender(<SpecSession {...props} draft={{ ...emptyDraft, goal: "agent takeover" }} />);
    expect(goalValue()).toBe("mid-edit rewrite");
    // Blur flushes the user's edit immediately (debounce cut short)...
    fireEvent.blur(goal);
    expect(onEditSpec).toHaveBeenCalledWith("goal", "mid-edit rewrite");
    // ...so the following agent re-draft (different value) is adopted again.
    view.rerender(<SpecSession {...props} draft={{ ...emptyDraft, goal: "agent takeover 2" }} />);
    expect(goalValue()).toBe("agent takeover 2");
  });

  it("adopts an agent re-draft for fields not being edited", () => {
    const { view, props } = setup();
    view.rerender(
      <SpecSession {...props} draft={{ ...emptyDraft, goal: "agent rewrite", plan: ["step"] }} />,
    );
    expect(goalValue()).toBe("agent rewrite");
    expect((screen.getByTestId("spec-plan") as HTMLTextAreaElement).value).toBe("step");
  });

  it("an incoming draft equal to the last sent edit is treated as an echo, not a clobber", () => {
    vi.useFakeTimers();
    const { view, props, onEditSpec } = setup();
    const goal = screen.getByTestId("spec-goal");
    fireEvent.change(goal, { target: { value: "my edit" } });
    vi.advanceTimersByTime(400);
    expect(onEditSpec).toHaveBeenCalledWith("goal", "my edit");
    // The server echoes our own PATCH back — the field keeps the same text.
    view.rerender(<SpecSession {...props} draft={{ ...emptyDraft, goal: "my edit" }} />);
    expect(goalValue()).toBe("my edit");
    expect(onEditSpec).toHaveBeenCalledTimes(1);
  });
});
