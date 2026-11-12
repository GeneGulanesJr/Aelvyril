/** The look the person asked their assistant for. The gateway's design.ts holds the limits; this only applies what it saved. */
export interface Design {
  accent?: string;
  frame?: string;
  orb?: string;
  home?: "edges" | "grid";
  mascot?: "hidden" | "small" | "medium" | "large";
  width?: "narrow" | "normal" | "wide";
  scale?: number;
  css?: string;
  /** Where each tile sits on the home grid. */
  layout?: Record<string, { x: number; y: number; w: number; h: number }>;
}

const VARS = ["--accent", "--primary", "--primary-hover", "--on-primary", "--you-mark", "--focus", "--indigo", "--indigo-2", "--rail-hover", "--oat", "--orb-a-user", "--orb-b-user", "--col", "--mascot-k", "--mascot-display"];
const WIDTH = { narrow: "640px", normal: "760px", wide: "920px" } as const;
const MASCOT = { small: "0.7", medium: "1", large: "1.25" } as const;
const mix = (c: string, pct: number, other: string) => `color-mix(in srgb, ${c} ${pct}%, ${other})`;

/** Dark or white text, whichever reads better on this colour. */
function ink(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#0b0e1a" : "#ffffff";
}

/** Sets the colours and sizes as CSS variables on the page, or clears them all for the original look.
    (The home layout, edges or grid, is a class on the shell: see Shell in App.tsx.) */
export function applyDesign(d: Design, root: HTMLElement = document.documentElement) {
  // The assistant's own css goes last so it wins. ?plain in the address skips it, in case it ever hides the way back.
  let tag = document.getElementById("user-css");
  if (!tag) (tag = document.createElement("style")), (tag.id = "user-css"), document.head.append(tag);
  tag.textContent = d.css && !new URLSearchParams(location.search).has("plain") ? d.css : "";
  const set = (name: string, v: string) => root.style.setProperty(name, v);
  for (const v of VARS) root.style.removeProperty(v);
  root.style.removeProperty("zoom");
  if (d.accent) {
    for (const v of ["--accent", "--primary", "--you-mark", "--focus"]) set(v, d.accent);
    set("--primary-hover", mix(d.accent, 85, "black"));
    set("--on-primary", ink(d.accent));
  }
  if (d.frame) {
    set("--indigo", d.frame);
    set("--indigo-2", mix(d.frame, 88, "white"));
    set("--rail-hover", mix(d.frame, 82, "white"));
    set("--oat", mix(d.frame, 78, "white"));
  }
  if (d.orb) {
    set("--orb-b-user", d.orb);
    set("--orb-a-user", mix(d.orb, 55, "white"));
  }
  if (d.width && d.width !== "normal") set("--col", WIDTH[d.width]);
  if (d.mascot === "hidden") set("--mascot-display", "none");
  else if (d.mascot && d.mascot !== "medium") set("--mascot-k", MASCOT[d.mascot]);
  if (d.scale && d.scale !== 100) root.style.setProperty("zoom", String(d.scale / 100));
}
