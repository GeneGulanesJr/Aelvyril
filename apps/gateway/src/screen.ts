/** What each device that opens the app says about its screen, so the assistant can design for it (the get_screen tool).
    In memory only: every open page reports again on load, on resize and every few minutes. Nothing leaves this computer. */
export interface Screen {
  kind: "phone" | "tablet" | "desktop";
  /** The window the app is drawn in, in CSS pixels. */
  viewport: { w: number; h: number };
  /** The whole display. */
  screen: { w: number; h: number };
  /** Device pixels per CSS pixel (2 on a sharp laptop or phone screen). */
  dpr: number;
  scheme: "dark" | "light";
  touch: boolean;
  orientation: "portrait" | "landscape";
  reducedMotion: boolean;
  browser: "Edge" | "Chrome" | "Safari" | "Firefox" | "other";
  /** Opened as an installed app rather than a browser tab. */
  installed: boolean;
  /** This page is the one on screen right now. */
  visible: boolean;
}
export type SeenScreen = Screen & { id: string; seen: number; current: boolean };

const KINDS = ["phone", "tablet", "desktop"] as const;
const SCHEMES = ["dark", "light"] as const;
const ORIENTATIONS = ["portrait", "landscape"] as const;
const BROWSERS = ["Edge", "Chrome", "Safari", "Firefox", "other"] as const;

const px = (v: unknown, max = 20_000) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > max) throw new Error("bad screen report");
  return Math.round(n);
};
const pick = <T extends string>(v: unknown, options: readonly T[]) => {
  if (typeof v !== "string" || !options.includes(v as T)) throw new Error("bad screen report");
  return v as T;
};

/** Checks one report from a browser (it is untrusted input) and returns it cleaned, or throws. */
export function cleanScreen(raw: Record<string, any>): Screen {
  const dpr = Number(raw.dpr);
  if (!Number.isFinite(dpr) || dpr < 0.5 || dpr > 8) throw new Error("bad screen report");
  return {
    kind: pick(raw.kind, KINDS),
    viewport: { w: px(raw.viewport?.w), h: px(raw.viewport?.h) },
    screen: { w: px(raw.screen?.w), h: px(raw.screen?.h) },
    dpr: Math.round(dpr * 100) / 100,
    scheme: pick(raw.scheme, SCHEMES),
    touch: raw.touch === true,
    orientation: pick(raw.orientation, ORIENTATIONS),
    reducedMotion: raw.reducedMotion === true,
    browser: pick(raw.browser, BROWSERS),
    installed: raw.installed === true,
    visible: raw.visible !== false,
  };
}

const KEEP_MS = 7 * 24 * 3600_000;
const RECENT_MS = 12 * 3600_000;
const MAX_DEVICES = 8;

export class ScreenStore {
  private devices = new Map<string, Screen & { seen: number }>();

  report(id: unknown, raw: Record<string, any>, now = Date.now()) {
    if (typeof id !== "string" || !/^[\w-]{6,64}$/.test(id)) throw new Error("bad screen report");
    this.devices.set(id, { ...cleanScreen(raw), seen: now });
    for (const [k, d] of this.devices) if (now - d.seen > KEEP_MS) this.devices.delete(k);
    // keep only the most recent few: an old phone or a long-gone tab should not pile up
    const newest = [...this.devices].sort((a, b) => b[1].seen - a[1].seen);
    for (const [k] of newest.slice(MAX_DEVICES)) this.devices.delete(k);
  }

  /** Devices seen in the last 12 hours, the most recent first. `current` is the page on screen right now (or the latest seen). */
  list(now = Date.now()): SeenScreen[] {
    const recent = [...this.devices]
      .filter(([, d]) => now - d.seen <= RECENT_MS)
      .sort((a, b) => b[1].seen - a[1].seen)
      .map(([id, d]) => ({ id, ...d, current: false }));
    const now1 = recent.find((d) => d.visible) ?? recent[0];
    if (now1) now1.current = true;
    return recent;
  }
}
