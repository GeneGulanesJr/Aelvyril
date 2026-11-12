// The contract between pi extensions and the web app.
// An extension calls pi.appendEntry(PANEL_TYPE, panel); the web app renders it.
// Both ends validate with parsePanel. `v` is the payload version (see docs/spec.md §4).
import { z } from "zod";

export const PANEL_TYPE = "aelvyril.panel";

const base = { v: z.literal(1), id: z.string().min(1), title: z.string().optional() };

const action = z.object({
  label: z.string(),
  /** Sent back to the thread as a prompt, e.g. "/approve". */
  command: z.string().startsWith("/"),
  style: z.enum(["default", "primary", "danger"]).optional(),
});

const field = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(["text", "textarea", "select", "checkbox"]),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
});

export const panelSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("markdown"), body: z.string() }),
  z.object({
    ...base,
    kind: z.literal("table"),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  }),
  z.object({
    ...base,
    kind: z.literal("list"),
    items: z.array(z.union([z.string(), z.object({ label: z.string(), detail: z.string().optional() })])),
  }),
  z.object({
    ...base,
    kind: z.literal("form"),
    fields: z.array(field),
    /** Sent as `${command} ${JSON.stringify(values)}`. */
    submit: z.object({ label: z.string(), command: z.string().startsWith("/") }),
  }),
  z.object({ ...base, kind: z.literal("diff"), patch: z.string() }),
  z.object({ ...base, kind: z.literal("actions"), actions: z.array(action) }),
  /** One big number or word at a glance ("28°C"), with a short label and an optional line under it. */
  z.object({
    ...base,
    kind: z.literal("stat"),
    value: z.string(),
    label: z.string().optional(),
    detail: z.string().optional(),
    tone: z.enum(["info", "success", "warning", "error"]).optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("status"),
    text: z.string(),
    tone: z.enum(["info", "success", "warning", "error"]).optional(),
  }),
]);

export type Panel = z.infer<typeof panelSchema>;
export type PanelAction = z.infer<typeof action>;

export function parsePanel(input: unknown): { ok: true; panel: Panel } | { ok: false; error: string } {
  const r = panelSchema.safeParse(input);
  return r.success ? { ok: true, panel: r.data } : { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}

/** For extension authors: validates, then emits. Throws on an invalid panel so the bug shows in the extension's own tests. */
export function emitPanel(pi: { appendEntry(customType: string, data?: unknown): void }, panel: unknown): void {
  const r = parsePanel(panel);
  if (!r.ok) throw new Error(`invalid panel: ${r.error}`);
  pi.appendEntry(PANEL_TYPE, r.panel);
}
