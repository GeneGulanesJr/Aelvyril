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
  // #84: usage accounting harvest — respond with fixed cumulative stats.
  if (cmd.type === "get_session_stats") {
    send({
      id: cmd.id,
      type: "response",
      command: cmd.type,
      success: true,
      data: {
        sessionId: "fake-session",
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 1,
        toolResults: 1,
        totalMessages: 2,
        tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
        cost: 0.0042,
      },
    });
    continue;
  }
  send({ id: cmd.id, type: "response", command: cmd.type, success: true });
  if (cmd.type === "extension_ui_response") {
    // #84: ack that the gateway's dialog response actually arrived, so
    // tests can assert the auto-responder end-to-end.
    send({ type: "custom_ui_response_received", requestId: cmd.id ?? null });
    continue;
  }
  if (cmd.type === "prompt") {
    // #84: opt-in blocking dialog (FAKE_UI_DIALOG=1) — the auto-responder
    // path in the gateway must answer it for the turn to settle.
    if (process.env.FAKE_UI_DIALOG === "1") {
      send({
        type: "extension_ui_request",
        id: "ui_1",
        method: "confirm",
        title: "Allow project agents?",
        message: "PiSubagent wants to run project agents.",
      });
    }
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
