// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DiffTab } from "./tabs.js";

// Two hunks covering both real header shapes: ranged old side ("@@ -1,2 +1,3 @@")
// and single-line old side ("@@ -10 +12,4 @@"), plus trailing section text.
const patch = [
  "@@ -1,2 +1,3 @@ fn()",
  " import x",
  "-old line",
  "+new line",
  "@@ -10 +12,4 @@ other()",
  " context after",
].join("\n");

function renderDiff() {
  return render(<DiffTab diff={[{ path: "a.ts", patch }]} />);
}

const lineNumber = (testId: string) =>
  (screen.getByTestId(testId).firstElementChild as HTMLElement).textContent;

describe("DiffTab new-file line numbers", () => {
  beforeEach(() => cleanup());

  it("walks real @@ hunk headers: numbers on context/'+' rows, blank on '-' rows and headers", () => {
    renderDiff();
    // Hunk 1 starts at new-file line 1.
    expect(lineNumber("diff-line-0")).toBe(""); // @@ header itself: no number
    expect(lineNumber("diff-line-1")).toBe("1"); // context
    expect(lineNumber("diff-line-2")).toBe(""); // "-old line": old file only
    expect(lineNumber("diff-line-3")).toBe("2"); // "+new line"
    // Hunk 2's header is parsed too (no comma on the old side): starts at 12.
    expect(lineNumber("diff-line-4")).toBe(""); // @@ header
    expect(lineNumber("diff-line-5")).toBe("12"); // context
  });
});
