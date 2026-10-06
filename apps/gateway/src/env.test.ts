import { describe, expect, it } from "vitest";
import { readNonNegativeInt, readPositiveInt, readPositiveNumber } from "./env.js";

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const before = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    fn();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}

describe("gateway env parsing (review P3)", () => {
  it("readPositiveInt: unset/blank → undefined, valid → number", () => {
    withEnv("GATEWAY_X", undefined, () => expect(readPositiveInt("GATEWAY_X")).toBeUndefined());
    withEnv("GATEWAY_X", "", () => expect(readPositiveInt("GATEWAY_X")).toBeUndefined());
    withEnv("GATEWAY_X", " 12 ", () => expect(readPositiveInt("GATEWAY_X")).toBe(12));
  });

  it("readPositiveInt throws at boot on garbage, zero, negatives, floats, Infinity", () => {
    for (const bad of ["abc", "0", "-3", "3.5", "Infinity", "NaN", "1e400", "1,000"]) {
      withEnv("GATEWAY_X", bad, () =>
        expect(() => readPositiveInt("GATEWAY_X")).toThrow(/GATEWAY_X/),
      );
    }
  });

  it("readNonNegativeInt: 0 is a documented off switch", () => {
    withEnv("GATEWAY_X", "0", () => expect(readNonNegativeInt("GATEWAY_X")).toBe(0));
    withEnv("GATEWAY_X", "-1", () => expect(() => readNonNegativeInt("GATEWAY_X")).toThrow());
    withEnv("GATEWAY_X", "2.2", () => expect(() => readNonNegativeInt("GATEWAY_X")).toThrow());
  });

  it("readPositiveNumber: fractional USD budgets allowed, non-positives rejected", () => {
    withEnv("GATEWAY_X", "0.5", () => expect(readPositiveNumber("GATEWAY_X")).toBe(0.5));
    withEnv("GATEWAY_X", "10", () => expect(readPositiveNumber("GATEWAY_X")).toBe(10));
    withEnv("GATEWAY_X", "0", () => expect(() => readPositiveNumber("GATEWAY_X")).toThrow());
    withEnv("GATEWAY_X", "-1", () => expect(() => readPositiveNumber("GATEWAY_X")).toThrow());
    withEnv("GATEWAY_X", "oops", () => expect(() => readPositiveNumber("GATEWAY_X")).toThrow());
  });
});
