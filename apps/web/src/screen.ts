import { store } from "./store.ts";

/** What this page tells the gateway about its screen, so the assistant can design for it. Stays on this computer. */
export interface ScreenReport {
  id: string;
  kind: "phone" | "tablet" | "desktop";
  viewport: { w: number; h: number };
  screen: { w: number; h: number };
  dpr: number;
  scheme: "dark" | "light";
  touch: boolean;
  orientation: "portrait" | "landscape";
  reducedMotion: boolean;
  browser: "Edge" | "Chrome" | "Safari" | "Firefox" | "other";
  installed: boolean;
  visible: boolean;
}

/** One id per browser, so a phone and a computer are told apart. */
function clientId(): string {
  let id = store.get("aelvyril.client");
  if (!id || !/^[\w-]{6,64}$/.test(id)) {
    id = `c${crypto.randomUUID()}`;
    store.set("aelvyril.client", id);
  }
  return id;
}

const browserName = (ua: string): ScreenReport["browser"] =>
  /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "other";

export function readScreen(): ScreenReport {
  const w = innerWidth;
  const h = innerHeight;
  const mq = (q: string) => matchMedia(q).matches;
  return {
    id: clientId(),
    // the same sizes the layout switches at, so "phone" means "the compact layout"
    kind: w <= 720 ? "phone" : w <= 1179 ? "tablet" : "desktop",
    viewport: { w, h },
    screen: { w: screen.width, h: screen.height },
    dpr: devicePixelRatio || 1,
    scheme: mq("(prefers-color-scheme: dark)") ? "dark" : "light",
    touch: mq("(pointer: coarse)") || navigator.maxTouchPoints > 0,
    orientation: h > w ? "portrait" : "landscape",
    reducedMotion: mq("(prefers-reduced-motion: reduce)"),
    browser: browserName(navigator.userAgent),
    installed: mq("(display-mode: standalone)"),
    visible: document.visibilityState === "visible",
  };
}
