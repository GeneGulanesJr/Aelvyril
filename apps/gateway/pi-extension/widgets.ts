// Bundled pi extension: lets the assistant put widgets (small cards) on the person's home screen by describing them.
// A widget is a card and, optionally, a public web address the gateway reads on a schedule to fill the card in.
// The gateway checks and stores everything (widgets.ts); nothing here runs code from the assistant.
// Not part of the gateway's typecheck: pi supplies "typebox" and the types when it loads this file.
import { Type } from "typebox";

async function call(method: string, path: string, body?: unknown) {
  const url = process.env.AELVYRIL_INTERNAL_URL;
  const token = process.env.AELVYRIL_INTERNAL_TOKEN;
  if (!url || !token) return { ok: false, data: { error: "Widgets are not available in this session." } };
  try {
    const res = await fetch(`${url}/internal/widgets${path}`, { method, headers: { "content-type": "application/json", "x-aelvyril-token": token }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { ok: res.ok, data: (await res.json().catch(() => ({}))) as any };
  } catch (e) {
    return { ok: false, data: { error: (e as Error).message } };
  }
}
const reply = (text: string, details: unknown = {}, isError = false) => ({ content: [{ type: "text", text }], details, isError });

const HOW =
  "A widget is a card on the person's home screen. card.kind is one of: " +
  "stat {value, label?, detail?, tone?} (one big value at a glance, e.g. '28°C'); markdown {body}; list {items: [string | {label, detail?}]}; " +
  "table {columns: [string], rows: [[string|number]]}; status {text, tone?: info|success|warning|error}. " +
  "Two ways to keep it current: (1) set by chat: give the content directly, and call show_widget again with the same id when it changes " +
  "(a reading list, a habit streak, a goal). (2) read from the web: give fetch {url, every (minutes, 5 to 1440)} for a public address that answers " +
  "JSON (or plain text, readable as {{text}}); the card's text may hold placeholders {{path.to.value}} or {{path|filter}}, filled from that answer " +
  "every time it is read. Paths use dots and list positions (hourly.temperature_2m.0). Filters: round, fixed1, fixed2, thousands, upper, lower, " +
  "weather (WMO weather code to emoji and word), time (ISO to HH:MM), date (ISO to YYYY-MM-DD), join (a list to 'a, b'), count (a list's length). " +
  "Only public addresses that need no key or login work (for example api.open-meteo.com for weather, no key needed).";

export default function (pi: any) {
  pi.registerTool({
    name: "show_widget",
    label: "Show a widget",
    description: `Add a widget to the home screen, or change one (same id replaces it). ${HOW}`,
    promptSnippet: "Put a widget (a small card that stays up to date) on the person's home screen",
    promptGuidelines: [
      "Use show_widget when the person wants something tracked or kept on screen (weather, a price, a score, a list, a countdown, a status). Prefer one compact stat or list card.",
      "After show_widget, read what came back: if 'missing' lists placeholders, fix the paths using 'paths' and call show_widget again with the same id. Then tell the person in one sentence what is on their home screen and how often it updates.",
      "Never write an extension or code to show something on screen; widgets are the way.",
    ],
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Short id like 'weather-angeles'. Reuse it to change an existing widget; leave it out for a new one (made from the title)." })),
      title: Type.String({ description: "Shown on top of the card, e.g. 'Weather in Angeles City'" }),
      card: Type.Object({ kind: Type.String() }, { additionalProperties: true, description: "The card: kind plus that kind's fields (see the tool description). Text may hold {{placeholders}} when fetch is set." }),
      fetch: Type.Optional(Type.Object({ url: Type.String({ description: "Public https address answering JSON or text" }), every: Type.Optional(Type.Number({ description: "Minutes between reads, 5 to 1440 (default 60)" })) })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const r = await call("POST", "", params);
      if (!r.ok) return reply(`Could not show the widget: ${r.data.error ?? "unknown error"}`, r.data, true);
      const { widget, missing, paths, error } = r.data;
      const lines = [`The widget "${widget.title}" (id ${widget.id}) is on the home screen${widget.every ? `, read every ${widget.every} minutes` : ""}. It shows: ${JSON.stringify(widget.panel)}`];
      if (error) lines.push(`Reading the address failed: ${error}.`);
      if (missing?.length) lines.push(`These placeholders found nothing: ${missing.join(", ")}. Fix them and call show_widget again with id ${widget.id}.`);
      if (paths?.length && (missing?.length || error)) lines.push(`Paths in the answer: ${paths.join("; ")}`);
      return reply(lines.join("\n"), r.data, !!error);
    },
  });

  pi.registerTool({
    name: "list_widgets",
    label: "List widgets",
    description: "The widgets on the home screen, with their cards (placeholders included), addresses and any last error. Use it before changing or removing one.",
    parameters: Type.Object({}),
    async execute() {
      const r = await call("GET", "");
      if (!r.ok) return reply(`Could not list widgets: ${r.data.error ?? "unknown error"}`, r.data, true);
      return reply(r.data.widgets.length ? JSON.stringify(r.data.widgets, null, 1) : "There are no widgets yet.", r.data);
    },
  });

  pi.registerTool({
    name: "remove_widget",
    label: "Remove a widget",
    description: "Take a widget off the home screen by its id (see list_widgets).",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id: string, params: { id: string }) {
      const r = await call("DELETE", `/${encodeURIComponent(params.id)}`);
      return r.ok ? reply(`Removed the widget ${params.id}.`) : reply(`Could not remove it: ${r.data.error ?? "unknown error"}`, r.data, true);
    },
  });
}
