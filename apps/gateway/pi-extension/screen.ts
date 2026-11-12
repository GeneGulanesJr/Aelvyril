// Bundled pi extension: lets the main conversation see what screen the person is using (size, phone or computer, dark or light),
// so a redesign suits it. Loaded only into the main conversation's pi process (see Supervisor.ensureHost).
// Not part of the gateway's typecheck: pi supplies "typebox" and the types when it loads this file.
import { Type } from "typebox";

/** What the layout does at each size: the assistant needs these facts to choose well. Keep in step with the web app's styles. */
const FACTS = [
  "How the app lays itself out:",
  "- The home screen is the orb, the chat box and a row of buttons (Stream, Tasks, Quick, Settings) along the bottom; windows under 1180px wide get a smaller orb (the 'home: grid' setting forces that on wide screens too).",
  "- At 720px wide or less it is a compact phone layout, and Tasks shows the list and the chosen task one at a time.",
  "- 'scale' (90 to 120) makes everything smaller or larger; on a phone, leave it alone unless asked. 'width' only matters on wide windows.",
  "- On a small or touch screen keep the orb at 'medium' or 'small' so the chat box stays on screen.",
].join("\n");

const ago = (ms: number) => (ms < 90_000 ? "just now" : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min ago` : `${Math.round(ms / 3_600_000)} h ago`);

export default function (pi: any) {
  pi.registerTool({
    name: "get_screen",
    label: "Look at the screen",
    description:
      "See what screen the person is using right now: the window size, the whole display, phone or tablet or computer, dark or light mode, touch or mouse, and the browser. " +
      "Use it before you change the look or layout, and whenever the person asks about their screen. It lists every device that opened the app recently, the one on screen first.",
    promptSnippet: "See the person's screen size and device before redesigning the app",
    parameters: Type.Object({}),
    async execute() {
      const url = process.env.AELVYRIL_INTERNAL_URL;
      const token = process.env.AELVYRIL_INTERNAL_TOKEN;
      if (!url || !token) return { content: [{ type: "text", text: "Looking at the screen is not available in this session." }], details: {}, isError: true };
      try {
        const res = await fetch(`${url}/internal/screen`, { headers: { "x-aelvyril-token": token } });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok) return { content: [{ type: "text", text: `Could not look at the screen: ${data.error ?? res.status}` }], details: {}, isError: true };
        const devices: any[] = data.devices ?? [];
        if (!devices.length) return { content: [{ type: "text", text: "No screen has reported yet. Ask the person to open the app, then try again." }], details: data };
        const now = Date.now();
        const lines = devices.map(
          (d, i) =>
            `${i + 1}. ${d.current ? "(on screen now) " : ""}${d.kind} · window ${d.viewport.w}×${d.viewport.h} · display ${d.screen.w}×${d.screen.h} at ${d.dpr}x · ${d.scheme} mode · ${d.touch ? "touch" : "mouse"} · ${d.orientation} · ${d.browser}${d.installed ? " (installed app)" : ""}${d.reducedMotion ? " · prefers less motion" : ""} · seen ${ago(now - d.seen)}`,
        );
        return { content: [{ type: "text", text: `${lines.join("\n")}\n\n${FACTS}` }], details: data };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not look at the screen: ${(e as Error).message}` }], details: {}, isError: true };
      }
    },
  });
}
