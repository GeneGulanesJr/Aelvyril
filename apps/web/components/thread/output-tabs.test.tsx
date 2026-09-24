import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { OutputTabs } from "./output-tabs.js";

function setup() {
  return render(
    <OutputTabs
      plan={["step1", "step2"]}
      trace={["hello", "world"]}
      diff={[{ path: "a.ts", patch: "@@ -1,2 +1,3 @@\n-old\n+new\n context" }]}
    />,
  );
}

describe("OutputTabs", () => {
  beforeEach(() => cleanup());

  it("switches between Plan / Trace / Diff tabs", () => {
    setup();
    expect(screen.getByText("step1").textContent).toBe("step1");
    fireEvent.click(screen.getByTestId("tab-trace"));
    expect(screen.getByText("hello").textContent).toBe("hello");
    fireEvent.click(screen.getByTestId("tab-diff"));
    expect(screen.getByText("a.ts").textContent).toBe("a.ts");
  });

  it("renders diff lines color-coded by prefix", () => {
    setup();
    fireEvent.click(screen.getByTestId("tab-diff"));
    expect(screen.getByTestId("diff-line-1").className).toContain("text-[#f85149]");
    expect(screen.getByTestId("diff-line-2").className).toContain("text-[#3fb950]");
    expect(screen.getByTestId("diff-line-3").className).toContain("text-[#8b96a8]");
  });

  it("plan tab is the default", () => {
    setup();
    expect(screen.getByTestId("tab-plan").getAttribute("data-active")).toBe("true");
  });
});
