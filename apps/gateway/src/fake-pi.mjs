// A scripted stand-in for `pi --mode rpc`, used by the gateway tests.
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// `pi install <source>` / `pi remove <source>`: edit settings.json like the real CLI does.
if (["install", "remove"].includes(process.argv[2])) {
  const file = join(process.env.PI_CODING_AGENT_DIR, "settings.json");
  const s = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const pkgs = new Set(s.packages ?? []);
  if (process.argv[2] === "install") pkgs.add(process.argv[3]);
  else pkgs.delete(process.argv[3]);
  if (process.argv[3]?.includes("broken")) process.exit(1);
  writeFileSync(file, JSON.stringify({ ...s, packages: [...pkgs] }));
  process.exit(0);
}

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let waitingAsk = null;
let slowCalls = 0;
let said = 0; // messages in the current session
let busy = false; // "/slow" keeps the agent working for a moment, like a real turn

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.type === "extension_ui_response" && waitingAsk === m.id) {
    waitingAsk = null;
    out({ type: "entry_appended", entry: { type: "custom", customType: "aelvyril.panel", data: { v: 1, id: "answer", kind: "markdown", body: `confirmed=${m.confirmed}` } } });
    return;
  }
  const reply = (data) => out({ id: m.id, type: "response", command: m.type, success: true, data });
  switch (m.type) {
    case "get_state":
      return reply({ sessionFile: null, sessionId: "fake", messageCount: said });
    case "new_session":
      said = 0;
      return reply({ cancelled: false });
    case "get_available_models":
      // FAKE_HANG_MARK: the very first process to be asked never answers (like a helper hung by a restart); its replacement does.
      if (process.env.FAKE_HANG_MARK && !existsSync(process.env.FAKE_HANG_MARK)) {
        writeFileSync(process.env.FAKE_HANG_MARK, "hung once");
        return;
      }
      // FAKE_MODELS_SLOW: like real pi right after start, the first two answers are empty.
      return reply({ models: process.env.FAKE_MODELS_SLOW && ++slowCalls <= 2 ? [] : [{ provider: "fake", id: "fake-1" }] });
    case "compact":
      out({ type: "compaction_start", reason: "manual" });
      out({ type: "compaction_end", reason: "manual", aborted: false });
      return reply({ summary: "fake summary", tokensBefore: 1 });
    case "set_model":
    case "abort":
      return reply({});
    case "prompt":
      // like real pi: a plain prompt while a turn runs is refused; it has to say steer or followUp
      if (busy && !m.streamingBehavior) return out({ id: m.id, type: "response", command: m.type, success: false, error: "Agent is already processing." });
      reply({ disposition: "queued" });
      if (busy) return;
      said++;
      if (m.message === "/slow") {
        busy = true;
        setTimeout(() => {
          out({ type: "agent_start" });
          out({ type: "agent_settled", aborted: false });
          busy = false;
        }, 60);
        return;
      }
      if (m.message.startsWith("[aelvyril:retry]")) {
        out({ type: "agent_start" });
        out({ type: "message_end", message: { role: "user", content: m.message } });
        out({ type: "entry_appended", entry: { type: "custom", customType: "aelvyril.task_outcome", data: { outcome: "done", summary: "retried ok" } } });
        out({ type: "agent_settled", aborted: false });
        return;
      }
      if (m.message.startsWith("[aelvyril:send-back]")) {
        out({ type: "agent_start" });
        out({ type: "message_end", message: { role: "user", content: m.message } });
        out({ type: "entry_appended", entry: { type: "custom", customType: "aelvyril.task_outcome", data: { outcome: "done", summary: `added ${/What is missing: (.*)/.exec(m.message)?.[1]}` } } });
        out({ type: "agent_settled", aborted: false });
        return;
      }
      if (m.message === "/die") {
        out({ type: "agent_start" });
        process.exit(1);
      } else if (m.message === "/stall") {
        out({ type: "agent_start" }); // then silence, like a provider that never answers
      } else if (m.message.startsWith("/outcome-")) {
        // a task that declares how it ended through finish_task (the task-guard extension's entry)
        const [kind, ...rest] = m.message.slice("/outcome-".length).split(" ");
        const outcome = { done: "done", need: "need_input", cannot: "cannot_finish", incomplete: "incomplete" }[kind];
        out({ type: "agent_start" });
        out({ type: "entry_appended", entry: { type: "custom", customType: "aelvyril.task_outcome", data: { outcome, summary: rest.join(" ") } } });
        out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "chatter that is not the result" }] } });
        out({ type: "agent_settled", aborted: false });
      } else if (m.message === "/panels") {
        // results on screen: p1 twice (the later one replaces it), p2, p3, p4, and a non-panel entry
        const panel = (id, body) => out({ type: "entry_appended", entry: { type: "custom", customType: "aelvyril.panel", data: { v: 1, id, kind: "markdown", body } } });
        out({ type: "agent_start" });
        panel("p1", "first");
        panel("p1", "second");
        panel("p2", "two");
        out({ type: "entry_appended", entry: { type: "custom", customType: "something.else", data: { id: "x" } } });
        panel("p3", "three");
        panel("p4", "four");
        out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "panels ready" }] } });
        out({ type: "agent_settled", aborted: false });
      } else if (m.message === "/ask") {
        waitingAsk = "ui-1";
        out({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Run project-local agents?", message: "Agents: scout" });
      } else {
        out({ type: "agent_start" });
        out({ type: "message_start", message: { role: "user", content: m.message } });
        out({ type: "message_end", message: { role: "user", content: m.message } });
        out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } });
        out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `echo: ${m.message}` }] } });
        out({ type: "agent_settled", aborted: false });
      }
      return;
  }
});
