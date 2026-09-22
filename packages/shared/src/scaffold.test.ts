import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./index.js";

describe("scaffold", () => {
  it("exports a schema version", () => {
    expect(SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
