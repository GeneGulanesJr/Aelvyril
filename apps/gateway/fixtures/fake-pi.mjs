// Scripted `pi --mode rpc` stand-in for tests/dev (Phase 1). Speaks the
// documented protocol: one response per command, then a fixed event sequence.
import readline from "node:readline"; // fake child MAY use readline — it IS a mock
import { setTimeout as sleep } from "node:timers/promises";

const rl = readline.createInterface({ input: process.stdin });
const delay = Number(process.env.FAKE_DELAY_MS ?? 5);

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

for await (const line of rl) {
  if (!line.trim()) continue;
  const cmd = JSON.parse(line);
  send({ id: cmd.id, type: "response", command: cmd.type, success: true });
  if (cmd.type === "prompt") {
    // Probe: echoes the gateway-injected env back over the protocol so tests
    // can assert the per-user namespace reached the session host (D7).
    send({ type: "custom_env_echo", LAPIS_PROJECT_KEY: process.env.LAPIS_PROJECT_KEY ?? null });
    send({ type: "turn_start" });
    send({ type: "message_start", message: { role: "assistant" } });
    for (const delta of ["Hello", ", ", "world", "!"]) {
      await sleep(delay);
      send({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta, contentIndex: 0 },
      });
    }
    await sleep(delay);
    send({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "/tmp/x" },
    });
    send({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      isError: false,
    });
    send({ type: "message_end", message: { role: "assistant" } });
    send({ type: "turn_end", toolResults: [] });
    send({ type: "agent_end", messages: [], willRetry: false });
    send({ type: "agent_settled" });
  } else if (cmd.type === "abort") {
    send({ type: "agent_settled" });
  }
}
