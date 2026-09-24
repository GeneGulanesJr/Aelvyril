import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
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
  render(
    <SpecSession
      questions={questions}
      draft={{ ...emptyDraft, goal: "add RBAC" }}
      status="spec'ing"
      onSubmitAnswers={onSubmitAnswers}
      onEditSpec={onEditSpec}
      onApprove={onApprove}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onSubmitAnswers, onEditSpec, onApprove, onCancel };
}

describe("SpecSession", () => {
  beforeEach(() => cleanup());

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

  it("edits draft fields and approves / cancels", () => {
    const { onEditSpec, onApprove, onCancel } = setup();
    fireEvent.change(screen.getByTestId("spec-goal"), { target: { value: "better goal" } });
    expect(onEditSpec).toHaveBeenCalledWith("goal", "better goal");
    fireEvent.change(screen.getByTestId("spec-files"), { target: { value: "a.ts, b.ts" } });
    expect(onEditSpec).toHaveBeenCalledWith("filesAffected", ["a.ts", "b.ts"]);
    fireEvent.click(screen.getByTestId("approve"));
    expect(onApprove).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("cancel"));
    expect(onCancel).toHaveBeenCalled();
  });
});
