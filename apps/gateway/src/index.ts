import { serve } from "@hono/node-server";
import { createGateway } from "./server.ts";

const gw = await createGateway();
const server = serve({ fetch: gw.app.fetch, port: gw.cfg.port, hostname: gw.cfg.host }, (i) =>
  console.log(`aelvyril listening on http://${i.address}:${i.port} (data: ${gw.cfg.dataDir})`),
);
if (gw.auth.setupCode() && !gw.cfg.openSetup) console.log(`\nFirst run: create the owner account in the browser.\nSetup code: ${gw.auth.setupCode()}\n`);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    gw.close();
    server.close();
    process.exit(0);
  });
}
