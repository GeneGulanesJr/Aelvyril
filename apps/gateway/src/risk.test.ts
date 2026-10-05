import { describe, expect, it } from "vitest";
import { classifyAction, classifyPlan } from "./risk.js";

const STANDARD = { autonomy: "standard" as const };
const ESTABLISHED = { autonomy: "established" as const };

describe("classifyAction (#81)", () => {
  it("workspace editing tools are reversible — they auto-run", () => {
    for (const tool of ["read", "edit", "write", "grep", "patch"]) {
      expect(classifyAction(tool, {}, STANDARD)).toMatchObject({ cls: "reversible", gated: false });
    }
  });

  it("sandbox promote / deploy tools are gated outright", () => {
    expect(classifyAction("sandbox_promote", {}, STANDARD)).toMatchObject({
      cls: "irreversible",
      gated: true,
    });
    expect(classifyAction("deploy", {}, STANDARD)).toMatchObject({ gated: true });
  });

  it("deletes and force-push shell commands are gated", () => {
    expect(classifyAction("bash", { command: "rm -rf ./node_modules" }, STANDARD)).toMatchObject({
      cls: "irreversible",
      gated: true,
    });
    expect(classifyAction("bash", { command: "git push origin main" }, STANDARD)).toMatchObject({
      gated: true,
      reason: "publishes commits to a remote",
    });
    expect(classifyAction("execute", { command: "DROP TABLE users;" }, STANDARD)).toMatchObject({
      gated: true,
    });
  });

  it("installs are external and gated at standard trust (#81.1)", () => {
    expect(classifyAction("bash", { command: "pnpm install" }, STANDARD)).toMatchObject({
      cls: "external",
      gated: true,
    });
    expect(classifyAction("bash", { command: "npm install left-pad" }, STANDARD)).toMatchObject({
      gated: true,
    });
  });

  it("trust escalation (#81.3): established namespaces auto-run external actions", () => {
    expect(classifyAction("bash", { command: "pnpm install" }, ESTABLISHED)).toMatchObject({
      cls: "external",
      gated: false,
    });
    // Irreversible actions stay gated even at established trust.
    expect(classifyAction("bash", { command: "rm -rf /" }, ESTABLISHED)).toMatchObject({
      gated: true,
    });
    expect(classifyAction("deploy", {}, ESTABLISHED)).toMatchObject({ gated: true });
  });

  it("unknown tools with no shell payload default to reversible", () => {
    expect(classifyAction("mystery_tool", { x: 1 }, STANDARD)).toMatchObject({
      cls: "reversible",
      gated: false,
    });
    // ...but unknown tools carrying a shell command still get scanned.
    expect(classifyAction("mystery_tool", { command: "git push" }, STANDARD)).toMatchObject({
      gated: true,
    });
  });

  it("reads argv-style args too", () => {
    expect(classifyAction("bash", { argv: ["rm", "-rf", "/"] }, STANDARD)).toMatchObject({
      gated: true,
    });
  });
});

describe("classifyPlan (#81.1)", () => {
  it("an all-reversible plan auto-runs", () => {
    const v = classifyPlan(["edit src/a.ts", "update the README"], STANDARD);
    expect(v.gated).toBe(false);
    expect(v.items).toHaveLength(0);
  });

  it("a plan with an install step gates the thread", () => {
    const v = classifyPlan(["pnpm install left-pad", "edit src/a.ts"], STANDARD);
    expect(v.gated).toBe(true);
    expect(v.items[0]).toMatchObject({ cls: "external", reason: "installs dependencies (external)" });
  });

  it("a plan with a deploy step gates regardless of trust", () => {
    expect(classifyPlan(["deploy to prod"], ESTABLISHED).gated).toBe(true);
  });

  it("external steps auto-run at established trust", () => {
    const v = classifyPlan(["pnpm install left-pad"], ESTABLISHED);
    expect(v.gated).toBe(false);
  });
});
