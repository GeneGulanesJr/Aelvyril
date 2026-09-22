import { buildApp } from "./app.js";

const port = Number(process.env.GATEWAY_PORT ?? 8787);
const app = buildApp({
  dbPath: process.env.GATEWAY_DB ?? "./data/gateway.db",
  childCommand: process.env.PI_COMMAND ?? "pi",
  childArgs: ["--mode", "rpc"],
});

app.listen({ port, host: "127.0.0.1" }).then((addr) => {
  app.log.info(`gateway listening on ${addr}`);
});
