import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { loadConfig, type Config } from "./config.ts";
import { openDb } from "./db.ts";
import { Extensions } from "./extensions.ts";
import { DesignStore } from "./design.ts";
import { ScreenStore } from "./screen.ts";
import { WidgetStore } from "./widgets.ts";
import { GitHub } from "./github.ts";
import { Projects } from "./projects.ts";
import { ProfileStore } from "./profile.ts";
import { Providers } from "./providers.ts";
import { Supervisor } from "./supervisor.ts";

export async function createGateway(cfg: Config = loadConfig()) {
  const db = openDb(cfg);
  const extraOrigins = (process.env.AELVYRIL_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const auth = await createAuth(cfg, db, extraOrigins);
  const profile = new ProfileStore(cfg, () => sup.configChanged());
  const design = new DesignStore(cfg);
  const screens = new ScreenStore();
  const widgets = new WidgetStore(cfg);
  const github = new GitHub(cfg);
  const projects = new Projects(cfg, github);
  if (process.env.AELVYRIL_WIDGETS !== "0") widgets.start(); // reads each widget's address when it is due
  const sup: Supervisor = new Supervisor(db, cfg, () => profile.get());
  sup.projectExists = (id) => !!projects.get(id);
  sup.recoverJobs();
  const providers = new Providers(cfg, () => sup.configChanged());
  const extensions = new Extensions(cfg, () => sup.configChanged());
  // Keep the extensions current without anyone having to ask: shortly after start, then once a day. AELVYRIL_AUTO_UPDATE=0 turns it off.
  const timers: NodeJS.Timeout[] = [];
  if (process.env.AELVYRIL_AUTO_UPDATE !== "0") {
    const run = () => void extensions.update().catch(() => {});
    timers.push(setTimeout(run, 2 * 60_000), setInterval(run, 24 * 3600_000));
    for (const t of timers) t.unref();
  }
  const app = createApp({ cfg, auth, sup, providers, extensions, profile, design, screens, widgets, github, projects });
  return {
    app,
    sup,
    providers,
    extensions,
    profile,
    design,
    screens,
    widgets,
    auth,
    cfg,
    close() {
      for (const t of timers) clearTimeout(t);
      widgets.stop();
      sup.shutdown();
      db.close();
    },
  };
}
