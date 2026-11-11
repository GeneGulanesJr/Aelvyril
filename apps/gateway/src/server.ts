import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { loadConfig, type Config } from "./config.ts";
import { openDb } from "./db.ts";
import { Extensions } from "./extensions.ts";
import { Providers } from "./providers.ts";
import { Supervisor } from "./supervisor.ts";

export async function createGateway(cfg: Config = loadConfig()) {
  const db = openDb(cfg);
  const extraOrigins = (process.env.AELVYRIL_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const auth = await createAuth(cfg, db, extraOrigins);
  const sup = new Supervisor(db, cfg);
  sup.recoverJobs();
  const providers = new Providers(cfg, () => sup.configChanged());
  const extensions = new Extensions(cfg, () => sup.configChanged());
  const app = createApp({ cfg, auth, sup, providers, extensions });
  return {
    app,
    sup,
    providers,
    extensions,
    auth,
    cfg,
    close() {
      sup.shutdown();
      db.close();
    },
  };
}
