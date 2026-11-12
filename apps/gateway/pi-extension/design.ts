// Bundled pi extension: lets the main conversation change how the app looks (colours and a few layout choices, each with
// limits the gateway enforces) when the person asks. Loaded only into the main conversation's pi process (see Supervisor.ensureHost).
// The code never changes.
// Not part of the gateway's typecheck: pi supplies "typebox" and the types when it loads this file.
import { Type } from "typebox";

export default function (pi: any) {
  pi.registerTool({
    name: "change_design",
    label: "Change the look",
    description:
      "Change how the app looks when the person asks (for example 'make it green', 'a darker background', 'bigger text', 'put the buttons under the orb'). " +
      "Colours (hex like #1f8a5b): accent (buttons, the person's messages), frame (the dark bar and home screen, must be dark), orb (the orb on the home screen). " +
      "Layout, within these limits only: home = edges (the four tiles on the left and right) or grid (tiles in a grid under the orb); " +
      "mascot = hidden, small, medium or large (the orb's size); width = narrow, normal or wide (the reading column in the Stream and tasks); " +
      "scale = 90 to 120 (percent, 100 is normal; makes everything smaller or larger). " +
      "For anything else, css: your own CSS rules, added after the app's so they win (call read_styles first to find the class names and colour variables). " +
      "css replaces the css you set before, so always send the whole set; an empty string removes it. No @import or web addresses (data: images are fine); at most 20000 characters. " +
      "Use reset to go back to the original look.",
    promptSnippet: "Change the app's colours and layout (within set limits) when the person asks",
    promptGuidelines: [
      "Use change_design only when the person asks to change how the app looks. Call get_screen first when the change is about layout or size, so it suits their screen.",
      "Choose good values yourself; do not ask which hex code or number. Say in one sentence what you changed and that they can ask for it back.",
      "Prefer the colour and layout settings; use css for what they can't do. Keep text readable in both light and dark, and never hide the Settings button or the chat box.",
      "If the css ever makes the app unusable, the person can open the app with ?plain at the end of the address to skip it.",
    ],
    parameters: Type.Object({
      accent: Type.Optional(Type.String({ description: "Main colour as hex, e.g. #1f8a5b" })),
      frame: Type.Optional(Type.String({ description: "Dark frame colour as hex; must be dark" })),
      orb: Type.Optional(Type.String({ description: "Orb colour as hex" })),
      home: Type.Optional(Type.Union([Type.Literal("edges"), Type.Literal("grid")], { description: "Home screen tiles: on the edges, or in a grid under the orb" })),
      mascot: Type.Optional(Type.Union([Type.Literal("hidden"), Type.Literal("small"), Type.Literal("medium"), Type.Literal("large")], { description: "Size of the orb" })),
      width: Type.Optional(Type.Union([Type.Literal("narrow"), Type.Literal("normal"), Type.Literal("wide")], { description: "Width of the reading column" })),
      scale: Type.Optional(Type.Number({ minimum: 90, maximum: 120, description: "Overall size in percent; 100 is normal" })),
      css: Type.Optional(Type.String({ description: "Your own CSS rules (the whole set; replaces what you set before; empty removes it)" })),
      reset: Type.Optional(Type.Boolean({ description: "Go back to the original look (can be combined with new settings)" })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const url = process.env.AELVYRIL_INTERNAL_URL;
      const token = process.env.AELVYRIL_INTERNAL_TOKEN;
      if (!url || !token) return { content: [{ type: "text", text: "Changing the look is not available in this session." }], details: {}, isError: true };
      try {
        const res = await fetch(`${url}/internal/design`, { method: "POST", headers: { "content-type": "application/json", "x-aelvyril-token": token }, body: JSON.stringify(params) });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok) return { content: [{ type: "text", text: `Could not change the look: ${data.error ?? res.status}` }], details: {}, isError: true };
        const { css, ...rest } = data.design ?? {};
        return { content: [{ type: "text", text: `The look is now: ${JSON.stringify(rest)}${css ? `, plus your css (${css.length} characters)` : ""}. The person sees it within a few seconds.` }], details: data };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not change the look: ${(e as Error).message}` }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "read_styles",
    label: "Read the app's styles",
    description:
      "Read the app's own stylesheet, to write css for change_design. Without match: the colour variables and every class name. " +
      "With match (e.g. '.widget' or '.dock'): the rules whose selector contains it. Also returns the css you set before.",
    promptSnippet: "Read the app's CSS class names and rules, before writing css",
    parameters: Type.Object({ match: Type.Optional(Type.String({ description: "Part of a selector, e.g. '.widget'" })) }),
    async execute(_id: string, params: { match?: string }) {
      const url = process.env.AELVYRIL_INTERNAL_URL;
      if (!url) return { content: [{ type: "text", text: "Not available in this session." }], details: {}, isError: true };
      try {
        const html = await (await fetch(`${url}/`)).text();
        const href = /href="(\/[^"]+\.css)"/.exec(html)?.[1];
        const sheet = href ? await (await fetch(url + href)).text() : "";
        const mine = (await (await fetch(`${url}/internal/design`, { headers: { "x-aelvyril-token": process.env.AELVYRIL_INTERNAL_TOKEN ?? "" } })).json().catch(() => ({}))).css ?? "";
        // shortcut: innermost rules only, so a rule inside @media shows without its media query; fine for finding selectors.
        const rules = [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2].trim() }));
        let text: string;
        if (params.match) {
          const hit = rules.filter((r) => r.sel.includes(params.match!)).map((r) => `${r.sel} { ${r.body} }`);
          text = hit.length ? hit.join("\n").slice(0, 12000) : `No rule's selector contains "${params.match}".`;
        } else {
          const vars = [...new Set(rules.filter((r) => r.sel === ":root").flatMap((r) => r.body.split(";")).filter((d) => d.trim().startsWith("--")).map((d) => d.trim()))];
          const classes = [...new Set([...sheet.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))].sort();
          text = `Colour and size variables (light theme):\n${vars.join(";\n").slice(0, 6000)}\n\nClass names:\n${classes.join(" ")}`;
        }
        return { content: [{ type: "text", text: `${text}\n\nYour css now: ${mine || "(none)"}` }], details: {} };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not read the styles: ${(e as Error).message}` }], details: {}, isError: true };
      }
    },
  });
}
