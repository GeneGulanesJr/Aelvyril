// Widgets: cards on the home screen that the assistant sets up by describing them, never by writing code.
// A widget is a card (a panel: stat, markdown, list, table or status) and, optionally, a public web address the gateway
// reads on a schedule. The card's text can hold {{path}} placeholders that are filled from what that address returns.
// Placeholders only fill in values; nothing in a widget ever runs.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePanel, type Panel } from "@aelvyril/ui-schema";
import type { Config } from "./config.ts";

export const LIMITS = { widgets: 24, minEvery: 5, maxEvery: 1440, bytes: 512 * 1024, timeoutMs: 10_000 };
/** Kinds a widget can be. Forms and buttons are left out: on the home screen there is no conversation for them to talk to. */
export const KINDS = ["stat", "markdown", "list", "table", "status"] as const;

export interface WidgetInput {
  id?: string;
  title: string;
  /** The card without v/id/title, e.g. { kind: "stat", value: "{{current.temperature_2m|round}}°C" }. */
  card: Record<string, unknown>;
  /** Read this public address every `every` minutes and fill the card's placeholders from it. */
  fetch?: { url: string; every?: number };
}

interface Stored {
  id: string;
  title: string;
  card: Record<string, unknown>;
  fetch?: { url: string; every: number };
  /** The card as shown: the last good fill. */
  panel: Panel;
  updated_at: number;
  fetched_at?: number;
  error?: string;
}

/** What the assistant hears back after setting up or refreshing a widget, so it can fix its own template. */
export interface Outcome {
  widget: ReturnType<WidgetStore["list"]>[number];
  /** Placeholders that found nothing in the data. */
  missing: string[];
  /** Some of the paths the data has, for writing placeholders. */
  paths: string[];
  error?: string;
}

// ---------------------------------------------------------------- filling placeholders
/** WMO weather codes (what open-meteo and most weather services report) as an emoji and a word. */
const WEATHER: Record<number, string> = {
  0: "☀️ Clear", 1: "🌤️ Mainly clear", 2: "⛅ Partly cloudy", 3: "☁️ Overcast", 45: "🌫️ Fog", 48: "🌫️ Fog",
  51: "🌦️ Light drizzle", 53: "🌦️ Drizzle", 55: "🌧️ Heavy drizzle", 56: "🌧️ Freezing drizzle", 57: "🌧️ Freezing drizzle",
  61: "🌧️ Light rain", 63: "🌧️ Rain", 65: "🌧️ Heavy rain", 66: "🌧️ Freezing rain", 67: "🌧️ Freezing rain",
  71: "🌨️ Light snow", 73: "🌨️ Snow", 75: "❄️ Heavy snow", 77: "🌨️ Snow grains", 80: "🌦️ Light showers", 81: "🌦️ Showers",
  82: "⛈️ Violent showers", 85: "🌨️ Snow showers", 86: "❄️ Heavy snow showers", 95: "⛈️ Thunderstorm", 96: "⛈️ Thunderstorm, hail", 99: "⛈️ Thunderstorm, hail",
};

export const FILTERS: Record<string, (v: unknown) => string> = {
  round: (v) => (Number.isFinite(Number(v)) ? String(Math.round(Number(v))) : String(v)),
  fixed1: (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(1) : String(v)),
  fixed2: (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : String(v)),
  thousands: (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-US") : String(v)),
  upper: (v) => String(v).toUpperCase(),
  lower: (v) => String(v).toLowerCase(),
  weather: (v) => WEATHER[Number(v)] ?? "🌡️ Unknown",
  /** "2026-11-12T14:00" → "14:00" */
  time: (v) => (/T(\d\d:\d\d)/.exec(String(v))?.[1] ?? String(v)),
  /** "2026-11-12T14:00" → "2026-11-12" */
  date: (v) => String(v).slice(0, 10),
  join: (v) => (Array.isArray(v) ? v.map(String).join(", ") : String(v)),
  count: (v) => (Array.isArray(v) ? String(v.length) : "0"),
};

/** The value at "a.b.0.c" in the data, or undefined. */
function at(data: unknown, path: string): unknown {
  let v: unknown = data;
  for (const k of path.split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

const PLACEHOLDER = /\{\{\s*([\w.$-]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g;

/** Fills every {{path}} or {{path|filter}} in the card's text. Nothing found shows as "–" and is reported. */
export function fill(card: unknown, data: unknown, missing: Set<string> = new Set()): unknown {
  if (typeof card === "string")
    return card.replace(PLACEHOLDER, (_m, path: string, filter?: string) => {
      const v = at(data, path);
      if (v === undefined || v === null) return missing.add(path), "–";
      const f = filter ? FILTERS[filter] : undefined;
      if (filter && !f) missing.add(`${path}|${filter} (no such filter)`);
      return f ? f(v) : typeof v === "object" ? JSON.stringify(v).slice(0, 200) : String(v);
    });
  if (Array.isArray(card)) return card.map((x) => fill(x, data, missing));
  if (card && typeof card === "object") return Object.fromEntries(Object.entries(card).map(([k, v]) => [k, fill(v, data, missing)]));
  return card;
}

/** Up to `max` leaf paths in the data (arrays show their first item only), so the assistant can write placeholders. */
export function paths(data: unknown, max = 60): string[] {
  const out: string[] = [];
  const walk = (v: unknown, p: string, depth: number): void => {
    if (out.length >= max) return;
    if (Array.isArray(v)) return v.length ? walk(v[0], `${p}.0`, depth + 1) : void out.push(`${p} (empty list)`);
    if (v && typeof v === "object" && depth < 4) for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k, depth + 1);
    else out.push(`${p} = ${JSON.stringify(v)?.slice(0, 40)}`);
  };
  walk(data, "", 0);
  return out;
}

// ---------------------------------------------------------------- reading the web, public addresses only
/** True for loopback, private, link-local, carrier-grade NAT and other non-public addresses (v4 and v6). */
export function isPrivate(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const s = ip.toLowerCase();
  return s === "::" || s === "::1" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80");
}

async function checkPublic(url: URL) {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("only http and https addresses can be read");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  // shortcut: the address is checked, then fetch looks it up again (a DNS-rebinding window); fine for one person's app, pin the IP if it is ever shared.
  if (!addrs.length || addrs.some(isPrivate)) throw new Error("that address is on a private network; widgets only read public web addresses");
}

/** Reads the address: JSON as data, anything else as { text }. Size and time are capped; redirects are refused (they could lead anywhere). */
async function read(url: string, doFetch: typeof fetch): Promise<unknown> {
  const u = new URL(url);
  await checkPublic(u);
  const res = await doFetch(u, { redirect: "error", signal: AbortSignal.timeout(LIMITS.timeoutMs), headers: { accept: "application/json, text/plain;q=0.8", "user-agent": "Aelvyril-widgets" } });
  if (!res.ok) throw new Error(`the address answered ${res.status}`);
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const r = await reader?.read();
    if (!r || r.done) break;
    size += r.value.byteLength;
    if (size > LIMITS.bytes) throw (await reader?.cancel(), new Error(`the answer is bigger than ${LIMITS.bytes / 1024} KB`));
    chunks.push(r.value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return { text: text.slice(0, 4000) };
  }
}

// ---------------------------------------------------------------- the store
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "widget";

/** Lives in the data folder next to the database. */
export class WidgetStore {
  private file: string;
  private items: Stored[] = [];
  private busy = new Set<string>();
  private timer?: NodeJS.Timeout;
  private doFetch: typeof fetch;

  constructor(cfg: Config, opts: { fetch?: typeof fetch } = {}) {
    this.file = join(cfg.dataDir, "widgets.json");
    this.doFetch = opts.fetch ?? fetch;
    try {
      if (existsSync(this.file)) {
        const saved = JSON.parse(readFileSync(this.file, "utf8"));
        if (Array.isArray(saved)) this.items = saved.filter((w) => w && typeof w.id === "string" && parsePanel(w.panel).ok);
      }
    } catch {
      // a damaged file just means no widgets
    }
  }

  /** What the home screen shows. */
  list() {
    return this.items.map((w) => ({ id: w.id, title: w.title, panel: w.panel, updated_at: w.updated_at, error: w.error, every: w.fetch?.every, url: w.fetch?.url }));
  }

  /** Everything, templates included, for the assistant to change a widget. */
  definitions() {
    return this.items.map(({ id, title, card, fetch, error }) => ({ id, title, card, fetch, error }));
  }

  /** Adds a widget, or replaces the one with the same id. Throws an Error that says what to fix. Reads the address once right away. */
  async upsert(input: WidgetInput): Promise<Outcome> {
    const title = String(input?.title ?? "").trim().slice(0, 80);
    if (!title) throw new Error("A widget needs a title.");
    const card = input?.card;
    if (!card || typeof card !== "object" || Array.isArray(card)) throw new Error("card must be an object like { kind: 'stat', value: '…' }.");
    if (!KINDS.includes(card.kind as (typeof KINDS)[number])) throw new Error(`card.kind must be one of: ${KINDS.join(", ")}.`);
    const id = input.id ? slug(String(input.id)) : slug(title);
    const exists = this.items.findIndex((w) => w.id === id);
    if (exists < 0 && this.items.length >= LIMITS.widgets) throw new Error(`There are already ${LIMITS.widgets} widgets; remove one first.`);
    let fetchDef: Stored["fetch"];
    if (input.fetch) {
      const every = Math.round(Number(input.fetch.every ?? 60));
      if (!Number.isFinite(every) || every < LIMITS.minEvery || every > LIMITS.maxEvery) throw new Error(`fetch.every is in minutes, from ${LIMITS.minEvery} to ${LIMITS.maxEvery}.`);
      try {
        await checkPublic(new URL(String(input.fetch.url)));
      } catch (e) {
        throw new Error(`fetch.url: ${(e as Error).message}`);
      }
      fetchDef = { url: String(input.fetch.url), every };
    }
    // the card has to be a valid panel once filled (with nothing: every placeholder shows "–")
    const { v: _v, id: _i, title: _t, ...rest } = card;
    const check = parsePanel({ ...(fill(rest, {}) as object), v: 1, id, title });
    if (!check.ok) throw new Error(`The card is not valid: ${check.error}`);
    const w: Stored = { id, title, card: rest, fetch: fetchDef, panel: check.panel, updated_at: Date.now() };
    if (exists >= 0) this.items[exists] = w;
    else this.items.push(w);
    if (!fetchDef) return this.save(), { widget: this.view(id), missing: [], paths: [] };
    return this.refresh(id);
  }

  remove(id: string): boolean {
    const n = this.items.length;
    this.items = this.items.filter((w) => w.id !== id);
    if (this.items.length === n) return false;
    this.save();
    return true;
  }

  /** Reads one widget's address and fills its card. A failed read keeps the last good card and notes the error. */
  async refresh(id: string): Promise<Outcome> {
    const w = this.items.find((x) => x.id === id);
    if (!w?.fetch) throw new Error("no such widget, or it does not read an address");
    this.busy.add(id);
    const missing = new Set<string>();
    let found: string[] = [];
    try {
      const data = await read(w.fetch.url, this.doFetch);
      found = paths(data);
      const r = parsePanel({ ...(fill(w.card, data, missing) as object), v: 1, id: w.id, title: w.title });
      if (!r.ok) throw new Error(`the filled card is not valid: ${r.error}`);
      Object.assign(w, { panel: r.panel, updated_at: Date.now(), error: undefined });
    } catch (e) {
      w.error = (e as Error).message;
    } finally {
      w.fetched_at = Date.now();
      this.busy.delete(id);
      this.save();
    }
    return { widget: this.view(id), missing: [...missing], paths: found, error: w.error };
  }

  /** Reads every widget whose time has come. Called every 30 seconds once started. */
  async tick(now = Date.now()) {
    const due = this.items.filter((w) => w.fetch && !this.busy.has(w.id) && (w.fetched_at ?? 0) + w.fetch.every * 60_000 <= now);
    await Promise.all(due.map((w) => this.refresh(w.id).catch(() => {})));
  }

  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  private view(id: string) {
    return this.list().find((w) => w.id === id)!;
  }

  private save() {
    writeFileSync(this.file, JSON.stringify(this.items, null, 2));
  }
}
