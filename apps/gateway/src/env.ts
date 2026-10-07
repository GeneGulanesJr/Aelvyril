/**
 * Review P3: strict numeric env parsing for the gateway's caps. A typo like
 * GATEWAY_MAX_SESSION_HOSTS=10O used to become NaN/undefined and silently
 * disable the cap. These helpers throw at BOOT on non-finite/non-positive
 * values so a misconfigured gateway refuses to start instead of running
 * unprotected.
 */

export type EnvReader = (name: string) => number | undefined;

function parse(name: string, value: number, kind: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite ${kind} (got non-numeric value)`);
  }
  return value;
}

/** Positive integers (1, 2, 3, ...) — most GATEWAY_* caps. */
export function readPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = parse(name, Number(raw), "positive integer");
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return value;
}

/** Non-negative integers (0, 1, 2, ...) — caps where 0 is a documented off switch. */
export function readNonNegativeInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = parse(name, Number(raw), "non-negative integer");
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (got ${JSON.stringify(raw)})`);
  }
  return value;
}

/** Positive numbers (fractional allowed) — e.g. GATEWAY_MAX_THREAD_COST_USD. */
export function readPositiveNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = parse(name, Number(raw), "positive number");
  if (value <= 0) {
    throw new Error(`${name} must be a positive number (got ${JSON.stringify(raw)})`);
  }
  return value;
}
