// A scripted, OpenAI-compatible model server for the browser and real-pi tests. No real AI, no cost.
//   node e2e/mock-model.mjs            (listens on :18777; MOCK_PORT to change)
//   GET /_stats                        request counters per scenario, for assertions
//
// Main conversation (it has the start_job tool):
//   "... do-job:<scenario> ..."        -> calls start_job with the task "scenario:<scenario>" (default "done")
//   after the tool result              -> "Started it, ask me anything else."
//   a finished-task hand-off message   -> "Your job finished: job-ok."
//   "... do-screen ..."                -> calls get_screen
//   "... do-design ..."                -> calls change_design (colours and layout)
//   anything else                      -> "Hello from mock"
// A background task (it has the finish_task tool); the scenario is read from "scenario:<name>" in the conversation:
//   done      -> finish_task(done, verified), then "job-ok"
//   untested  -> writes a file, tries to declare done WITHOUT checking it (must be refused), then reads the file and declares done
//   noverify  -> declares done without saying what it checked (must be refused), then says it
//   neverchecks -> writes a file and keeps declaring done without ever checking (refused 4 times, then recorded as not tested)
//   silent    -> never calls finish_task: always answers "I think that is all."  (the guard must nudge, then give up)
//   nudged    -> answers without finish_task first; calls finish_task(done) once nudged
//   need      -> finish_task(need_input, "Which folder?"); after a person's answer, finish_task(done)
//   cannot    -> finish_task(cannot_finish, "there is no network")
//   hang      -> never answers (the gateway's stall watchdog must step in)
import http from "node:http";

const stats = { lastToolResult: "", mainSystem: "", requests: 0, byScenario: {}, finishTaskCalls: {}, nudgesSeen: {}, ponytail: [] };
const send = (res, chunks) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "spike-1", ...c })}\n\n`);
  res.end("data: [DONE]\n\n");
};
const text = (t) => [
  { choices: [{ index: 0, delta: { role: "assistant", content: t }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
];
const call = (name, args) => [
  { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_" + Math.random().toString(36).slice(2, 8), type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
];
const flat = (m) => (typeof m.content === "string" ? m.content : (m.content || []).map((c) => c.text || "").join(""));

http
  .createServer((req, res) => {
    if (req.url === "/_stats") return res.end(JSON.stringify(stats));
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const j = JSON.parse(body || "{}");
      stats.requests++;
      const tools = (j.tools || []).map((t) => t.function?.name);
      const msgs = j.messages || [];
      const last = msgs.at(-1) || {};
      const lastText = flat(last);
      const all = msgs.map(flat).join("\n");
      // does ponytail's instruction block reach the model, and at which level? (checked by the Docker test)
      const pony = (msgs.filter((m) => m.role === "system").map(flat).join("\n").match(/PONYTAIL MODE ACTIVE[^\n]{0,60}/i) || [])[0];
      if (pony && !stats.ponytail.includes(pony)) stats.ponytail.push(pony);
      // what the main conversation (the one with start_job) was told, for the identity checks
      if (tools.includes("start_job")) stats.mainSystem = msgs.filter((m) => m.role === "system").map(flat).join("\n");

      if (tools.includes("finish_task")) {
        const scenario = (all.match(/scenario:(\w+)/) || [])[1] || "done";
        stats.byScenario[scenario] = (stats.byScenario[scenario] || 0) + 1;
        const nudged = lastText.includes("You stopped without calling finish_task");
        if (nudged) stats.nudgesSeen[scenario] = (stats.nudgesSeen[scenario] || 0) + 1;
        const toolResult = last.role === "tool" ? lastText : "";
        const finish = (outcome, summary, verified) => {
          stats.finishTaskCalls[scenario] = (stats.finishTaskCalls[scenario] || 0) + 1;
          return call("finish_task", { outcome, summary, ...(verified ? { verified } : {}) });
        };
        const steps = msgs.filter((m) => m.role === "tool").length; // tool results so far in this conversation
        if (scenario === "hang") return; // never answer
        if (scenario === "silent") return send(res, text("I think that is all."));
        if (scenario === "nudged") return send(res, nudged ? finish("done", "job-ok", "looked at the result: job-ok") : toolResult ? text("job-ok") : text("Working on it."));
        if (scenario === "untested") {
          if (steps === 0) return send(res, call("write", { path: "notes.txt", content: "hello from the task" }));
          if (steps === 1) return send(res, finish("done", "job-ok", "I wrote the file and it looks fine")); // refused: nothing was checked after the change
          if (steps === 2) return send(res, call("read", { path: "notes.txt" }));
          if (steps === 3) return send(res, finish("done", "job-ok", "re-read notes.txt: it says hello from the task"));
          return send(res, text("job-ok"));
        }
        if (scenario === "noverify") {
          if (steps === 0) return send(res, finish("done", "job-ok")); // refused: no "verified"
          if (steps === 1) return send(res, finish("done", "job-ok", "looked at the result: job-ok"));
          return send(res, text("job-ok"));
        }
        if (scenario === "neverchecks") {
          if (steps === 0) return send(res, call("write", { path: "notes.txt", content: "x" }));
          if (toolResult.startsWith("Recorded")) return send(res, text("Sorry, I could not test it."));
          return send(res, finish("done", "job-ok", "I wrote the file and it looks fine")); // refused again and again
        }
        if (scenario === "cannot") return send(res, toolResult ? text("Sorry.") : finish("cannot_finish", "there is no network"));
        if (scenario === "need") {
          const answered = msgs.some((m) => m.role === "user" && /the photos folder/i.test(flat(m)));
          if (toolResult) return send(res, text(answered ? "job-ok" : "Which folder?"));
          return send(res, answered ? finish("done", "job-ok", "looked at the result: job-ok") : finish("need_input", "Which folder?"));
        }
        // done
        if (toolResult) return send(res, text("job-ok"));
        return send(res, finish("done", "job-ok", "looked at the result: job-ok"));
      }

      if (tools.includes("start_job") && last.role === "user" && lastText.includes("do-job")) {
        const scenario = (lastText.match(/do-job:(\w+)/) || [])[1] || "done";
        return send(res, call("start_job", { title: "Test job", task: `scenario:${scenario} say job-ok` }));
      }
      if (tools.includes("get_screen") && last.role === "user" && lastText.includes("do-screen")) return send(res, call("get_screen", {}));
      if (tools.includes("change_design") && last.role === "user" && lastText.includes("do-design")) return send(res, call("change_design", { accent: "#1f8a5b", orb: "#ff8800", home: "grid", mascot: "large", width: "wide", scale: 110 }));
      if (last.role === "tool") {
        stats.lastToolResult = lastText; // what the last tool told the model, for the get_screen check
        return send(res, text("Started it, ask me anything else."));
      }
      if (lastText.includes("[aelvyril:job-result]")) return send(res, text("Your job finished: job-ok."));
      if (lastText.includes("say job-ok")) return send(res, text("job-ok"));
      return send(res, text("Hello from mock"));
    });
  })
  .listen(Number(process.env.MOCK_PORT ?? 18777), () => console.log(`mock model on :${process.env.MOCK_PORT ?? 18777}`));
