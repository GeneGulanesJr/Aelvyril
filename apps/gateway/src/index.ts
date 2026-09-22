import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";

const port = Number(process.env.GATEWAY_PORT ?? 8787);
const useFakeChild = process.env.PI_FAKE === "1";

const app = buildApp({
  dbPath: process.env.GATEWAY_DB ?? "./data/gateway.db",
  childCommand: useFakeChild ? process.execPath : (process.env.PI_COMMAND ?? "pi"),
  childArgs: useFakeChild
    ? [fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url))]
    : ["--mode", "rpc"],
  idleMs: Number(process.env.GATEWAY_IDLE_MS ?? 300_000),
});

await app.listen({ port, host: "127.0.0.1" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
