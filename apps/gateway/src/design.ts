import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";

/** The look the person asked their assistant for. A few colours and a few layout choices, each with limits:
    the assistant can never produce a broken or unreadable screen, and the code never changes. */
export interface Design {
  /** The main colour: buttons, your messages, the chosen item. */
  accent?: string;
  /** The dark frame around the window (the bar and the home screen). */
  frame?: string;
  /** The orb in the middle of the home screen. */
  orb?: string;
  /** Home screen: the four tiles on the left and right edges, or in a grid under the orb. */
  home?: "edges" | "grid";
  /** How big the orb is on the home screen, or hidden. */
  mascot?: "hidden" | "small" | "medium" | "large";
  /** How wide the reading column is in the Stream and tasks. */
  width?: "narrow" | "normal" | "wide";
  /** Everything a bit smaller or larger, in percent. */
  scale?: number;
  /** The assistant's own CSS, added after the app's. Plain styling only: no imports or web addresses. */
  css?: string;
  /** Where each tile sits on the home screen's 12-column grid (set by the person dragging them). */
  layout?: Record<string, { x: number; y: number; w: number; h: number }>;
}
export type DesignChange = Design & { reset?: boolean };

export const CHOICES = {
  home: ["edges", "grid"],
  mascot: ["hidden", "small", "medium", "large"],
  width: ["narrow", "normal", "wide"],
} as const;
export const SCALE = { min: 90, max: 120 };

/** Accepts #rgb or #rrggbb in any case; returns #rrggbb, or null. */
function hex(v: unknown): string | null {
  const m = typeof v === "string" ? /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim()) : null;
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${h.toLowerCase()}`;
}
/** Relative luminance, 0 (black) to 1 (white). */
function luminance(h: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Colour limits, with the reason said to the assistant (and so the person) in plain words. */
const COLORS: Record<"accent" | "frame" | "orb", { min: number; max: number; why: string }> = {
  accent: { min: 0.04, max: 0.6, why: "it has to stand out on both the dark frame and the light page" },
  frame: { min: 0, max: 0.12, why: "the frame is dark so the light text on it stays readable" },
  orb: { min: 0.02, max: 0.9, why: "it has to show against the dark home screen" },
};

/** One setting, checked: the cleaned value, or what to fix. */
function check(key: keyof Design, v: unknown): { value: unknown } | { error: string } {
  if (key === "layout") {
    if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "layout must be an object: tile id → { x, y, w, h }." };
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length > 60) return { error: "layout has too many tiles." };
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
    for (const [id, t] of entries) {
      const [x, y, w, h] = ["x", "y", "w", "h"].map((k) => Number((t as Record<string, unknown>)?.[k]));
      if (!/^[\w:.-]{1,80}$/.test(id) || ![x, y, w, h].every(Number.isInteger) || x < 0 || w < 1 || x + w > 12 || y < 0 || y > 500 || h < 1 || h > 60)
        return { error: `layout tile "${id}" must be whole numbers inside the 12-column grid.` };
      out[id] = { x, y, w, h };
    }
    return { value: out };
  }
  if (key === "css") {
    if (typeof v !== "string") return { error: "css must be text." };
    if (v.length > CSS_MAX) return { error: `The css is too long (${v.length} characters; at most ${CSS_MAX}). Keep only the rules that change something.` };
    // Nothing that loads from elsewhere (it could leak what is on screen) or runs code. data: images are fine.
    const bad = /@import|url\(\s*['"]?\s*(?!data:)|expression\s*\(|javascript:|behavior\s*:|-moz-binding|<\/?style/i.exec(v);
    if (bad) return { error: `The css can't use "${bad[0].trim()}": it may not load anything from the web or run code. Use colours, gradients and data: images instead.` };
    return { value: v.trim() };
  }
  if (key in COLORS) {
    const r = COLORS[key as keyof typeof COLORS];
    const h = hex(v);
    if (!h) return { error: `The ${key} colour must be a hex colour like #1f8a5b.` };
    const l = luminance(h);
    if (l < r.min || l > r.max) return { error: `${h} can't be the ${key} colour: ${r.why}. Pick ${l < r.min ? "a lighter" : "a darker"} one.` };
    return { value: h };
  }
  if (key === "scale") {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (!Number.isFinite(n) || n < SCALE.min || n > SCALE.max) return { error: `The scale must be a number from ${SCALE.min} to ${SCALE.max} (percent; 100 is normal).` };
    return { value: Math.round(n) };
  }
  const options = CHOICES[key as keyof typeof CHOICES] as readonly string[];
  if (typeof v !== "string" || !options.includes(v)) return { error: `The ${key} must be one of: ${options.join(", ")}.` };
  return { value: v };
}

export const CSS_MAX = 20_000;
const KEYS = ["accent", "frame", "orb", "home", "mascot", "width", "scale", "css", "layout"] as const satisfies readonly (keyof Design)[];

/** Lives in the data folder next to the database. */
export class DesignStore {
  private file: string;
  private value: Design = {};

  constructor(cfg: Config) {
    this.file = join(cfg.dataDir, "design.json");
    try {
      if (existsSync(this.file)) {
        const saved = JSON.parse(readFileSync(this.file, "utf8"));
        for (const k of KEYS) {
          const r = saved?.[k] === undefined ? null : check(k, saved[k]);
          if (r && "value" in r) (this.value as Record<string, unknown>)[k] = r.value;
        }
      }
    } catch {
      // a damaged file just means the original look
    }
  }

  get(): Design {
    return { ...this.value };
  }

  /** Applies a change, or throws an Error whose message says what to fix. Nothing is saved unless every part is fine. */
  set(change: DesignChange): Design {
    const next: Design = change.reset ? {} : { ...this.value };
    for (const k of KEYS) {
      if (change[k] === undefined) continue;
      const r = check(k, change[k]);
      if ("error" in r) throw new Error(r.error);
      (next as Record<string, unknown>)[k] = r.value;
    }
    if (!next.css) delete next.css;
    this.value = next;
    writeFileSync(this.file, JSON.stringify(next, null, 2));
    return this.get();
  }
}
