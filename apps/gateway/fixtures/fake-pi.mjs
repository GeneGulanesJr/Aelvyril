// Scripted `pi --mode rpc` stand-in for tests/dev (Phase 1). Speaks the
// documented protocol: one response per command, then a fixed event sequence.
//
// #80/#81/#82 scripted contract flows (opt-in env):
//   FAKE_SPEC_QUESTIONS=1   first prompt → custom_spec_question, end turn
//   FAKE_PLAN_JSON=[...]    draft plan used for the custom_spec_draft signal
//                           (default: reversible → auto-run path)
//   FAKE_GATED_TOOL=1       execution turn starts with a bash `rm -rf` call
//   FAKE_EDIT_FILE=path     execution turn writes this file (relative to cwd)
//                           so the gateway's git-diff producer sees real edits
import readline from "node:readline"; // fake child MAY use readline — it IS a mock
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const rl = readline.createInterface({ input: process.stdin });
const delay = Number(process.env.FAKE_DELAY_MS ?? 5);

// Queue-based reader: a blocking extension_ui_request must be able to park
// the prompt sequence while still consuming stdin lines (the gateway's
// extension_ui_response arrives on the same stream). Real pi blocks the
// turn until the dialog is answered — the mock must too, or a blocked-mode
// escalation gets erased by the settle that would never happen for real.
const lines = [];
rl.on("line", (l) => lines.push(l));
async function readLine() {
  while (lines.length === 0) await sleep(2);
  return lines.shift();
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function answerAndAck(cmd) {
  send({ id: cmd.id, type: "response", command: cmd.type, success: true });
  send({ type: "custom_ui_response_received", requestId: cmd.id ?? null });
}

let specAsked = false;
let gatedFired = false;

function planFromEnv() {
  try {
    const parsed = JSON.parse(process.env.FAKE_PLAN_JSON ?? "");
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // fall through to the default reversible plan
  }
  return ["wire the module exports", "update the README"];
}

async function executionTurn() {
  // #81: opt-in gated action FIRST — the gateway must stop the run before
  // the irreversible command "completes". Fires once per process: after the
  // user approves, the retried run proceeds past it (the action is now on
  // the allowlist).
  if (process.env.FAKE_GATED_TOOL === "1" && !gatedFired) {
    gatedFired = true;
    send({
      type: "tool_execution_start",
      toolCallId: "call_gated",
      toolName: "bash",
      args: { command: "rm -rf ./build-output" },
    });
    // Real pi would run the tool; here the gateway's abort ends the turn.
    return;
  }
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
  // #80: real edit in the workspace cwd so the gateway's git-diff producer
  // computes a genuine diff envelope.
  const editFile = process.env.FAKE_EDIT_FILE;
  if (editFile) {
    try {
      writeFileSync(join(process.cwd(), editFile), "edited by fake-pi\n");
    } catch {
      // cwd may not exist in some tests; the diff override covers those
    }
  }
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
}

async function main() {
  for (;;) {
    const line = await readLine();
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
    if (cmd.type === "extension_ui_response") {
      answerAndAck(cmd);
      continue;
    }
    if (cmd.type === "abort") {
      send({ id: cmd.id, type: "response", command: cmd.type, success: true });
      send({ type: "agent_settled" });
      continue;
    }
    send({ id: cmd.id, type: "response", command: cmd.type, success: true });
    if (cmd.type !== "prompt") continue;
    const msg = String(cmd.message ?? "");
    // #84: opt-in blocking dialog (FAKE_UI_DIALOG=1) — holds the turn open
    // until the gateway answers, exactly like real pi.
    if (process.env.FAKE_UI_DIALOG === "1") {
      send({
        type: "extension_ui_request",
        id: "ui_1",
        method: "confirm",
        title: "Allow project agents?",
        message: "PiSubagent wants to run project agents.",
      });
      for (;;) {
        const l = await readLine();
        let c;
        try {
          c = JSON.parse(l);
        } catch {
          continue;
        }
        if (c.type === "extension_ui_response") {
          answerAndAck(c);
          break;
        }
        // Anything else mid-dialog: the mock ignores it and keeps waiting
        // (no test flow sends commands while a dialog is pending).
      }
    }
    // Probe: echoes the gateway-injected env back over the protocol so tests
    // can assert the per-user namespace reached the session host (D7).
    send({ type: "custom_env_echo", LAPIS_PROJECT_KEY: process.env.LAPIS_PROJECT_KEY ?? null });

    // #80: scripted spec interview — ask once, end the turn; the gateway
    // drives answers → draft → execution.
    if (process.env.FAKE_SPEC_QUESTIONS === "1" && !specAsked && !msg.startsWith("Spec approved")) {
      specAsked = true;
      send({
        type: "custom_spec_question",
        questions: [{ id: "q1", prompt: "What shape should it take?", kind: "text" }],
      });
      send({ type: "turn_end", toolResults: [] });
      send({ type: "agent_settled" });
      continue;
    }
    // Contract replies are prefix-distinguishable from wrapped user prompts
    // (which embed the protocol instructions mentioning custom_spec_draft).
    if (
      msg.startsWith("Answers updated") ||
      msg.startsWith("User edited spec field") ||
      msg.startsWith("Question budget exhausted")
    ) {
      send({
        type: "custom_spec_draft",
        draft: {
          goal: "scripted goal",
          filesAffected: ["src/a.ts"],
          plan: planFromEnv(),
          risks: [],
          questions: [{ id: "q1", prompt: "What shape should it take?", kind: "text" }],
          answers: { q1: "answered" },
        },
      });
      send({ type: "turn_end", toolResults: [] });
      send({ type: "agent_settled" });
      continue;
    }
    await executionTurn();
  }
}

main();
