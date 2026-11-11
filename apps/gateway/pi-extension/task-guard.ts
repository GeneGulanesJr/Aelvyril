// Bundled pi extension, loaded only into background tasks: makes "finished" mean finished AND checked.
//  - finish_task is how the AI declares the outcome (done / need_input / cannot_finish).
//  - Testing guardrail: "done" is refused unless the task says what it checked and what that showed, and
//    unless anything it changed was checked afterwards (a test run, or looking at the result). A last check
//    that failed cannot be declared "done". Repeated attempts to skip this end as honestly "not tested".
//  - If the AI tries to stop without declaring an outcome, pi's last checkpoint (agent_before_settle) sends it
//    back to work, up to MAX_NUDGES times; after that the task is reported as incomplete.
// The outcome travels to the gateway as a session entry ("aelvyril.task_outcome"), so it also survives in the log.
// Not part of the gateway's typecheck: pi supplies "typebox" and the types when it loads this file.
import { Type } from "typebox";

const MAX_NUDGES = 3;
const MAX_REFUSALS = 4;
const OUTCOME_ENTRY = "aelvyril.task_outcome";
const CHANGES = new Set(["write", "edit"]);

const NUDGE =
  "You stopped without calling finish_task. Look at the original request again. " +
  "If everything is done and checked, call finish_task with outcome \"done\", what you checked (\"verified\") and a short summary in plain language. " +
  "If you cannot continue without an answer from the person, call finish_task with outcome \"need_input\" and the one question you need. " +
  "If you truly cannot do it, call finish_task with outcome \"cannot_finish\" and the honest reason. Otherwise keep working.";

export default function (pi: any) {
  let outcome: { outcome: string; summary: string; verified?: string } | null = null;
  let nudges = 0;
  let refusals = 0;
  let changed = false; // something was written or edited this round
  let checksSinceChange = 0; // tool calls (read, bash, ...) made after the last change
  let lastCheckFailed = false;

  // A new instruction from the person starts a fresh round.
  pi.on("before_agent_start", async () => {
    outcome = null;
    nudges = 0;
    refusals = 0;
    changed = false;
    checksSinceChange = 0;
    lastCheckFailed = false;
  });

  pi.on("tool_call", async (event: any) => {
    if (event.toolName === "finish_task") return;
    if (CHANGES.has(event.toolName)) {
      changed = true;
      checksSinceChange = 0;
      lastCheckFailed = false;
    } else {
      checksSinceChange++;
    }
  });
  pi.on("tool_result", async (event: any) => {
    if (event.toolName === "finish_task" || CHANGES.has(event.toolName)) return;
    if (checksSinceChange > 0) lastCheckFailed = !!event.isError;
  });

  /** Why "done" is not accepted yet, or null when it is. */
  const refusal = (verified: string): string | null => {
    if (verified.trim().length < 8) {
      return "Not yet: say in \"verified\" what you checked and what it showed (for example the test you ran and its result, or the file you re-read). If nothing can be checked, say why. Then call finish_task again.";
    }
    if (changed && checksSinceChange === 0) {
      return "Not yet: you changed things but did not check them afterwards. Run the tests if there are any, or look at the real result (read the file, list the folder, run it). Then call finish_task again.";
    }
    if (lastCheckFailed) {
      return "Not yet: your last check failed. Fix the problem and run the check again. If it truly cannot be fixed, call finish_task with outcome \"cannot_finish\" and say what failed.";
    }
    return null;
  };

  pi.registerTool({
    name: "finish_task",
    label: "Finish the task",
    description:
      "Declare how this task ended. Call it exactly once, at the very end. " +
      "outcome \"done\": the work is complete AND checked (summary = what you did and where the result is; verified = what you ran or looked at to check it and what it showed). " +
      "Anything you changed must be checked afterwards, with tests if there are any. " +
      "outcome \"need_input\": you cannot continue without an answer from the person (summary = the one question). " +
      "outcome \"cannot_finish\": it cannot be done (summary = the honest reason).",
    promptSnippet: "Declare how the task ended (done with how you checked it, need_input, or cannot_finish)",
    promptGuidelines: [
      "Never end your turn without calling finish_task, never claim \"done\" for work you have not checked, and check anything you changed (run the tests if there are any) before calling finish_task.",
    ],
    parameters: Type.Object({
      outcome: Type.Union([Type.Literal("done"), Type.Literal("need_input"), Type.Literal("cannot_finish")], { description: "How the task ended" }),
      summary: Type.String({ description: "Plain-language summary, the question, or the reason, written for a non-technical person" }),
      verified: Type.Optional(Type.String({ description: "For done: what you ran or looked at to check the result and what it showed" })),
    }),
    async execute(_id: string, params: { outcome: string; summary: string; verified?: string }) {
      if (params.outcome === "done") {
        const why = refusal(params.verified ?? "");
        if (why) {
          refusals++;
          if (refusals < MAX_REFUSALS) return { content: [{ type: "text", text: why }], details: {} };
          // It keeps trying to finish without testing: say so honestly instead of calling it done.
          outcome = { outcome: "cannot_finish", summary: "It could not show that the result was tested." };
          pi.appendEntry(OUTCOME_ENTRY, outcome);
          return { content: [{ type: "text", text: "Recorded as not finished: the result was not tested. You can stop now." }], details: outcome };
        }
      }
      outcome = { outcome: params.outcome, summary: params.summary, ...(params.verified ? { verified: params.verified } : {}) };
      pi.appendEntry(OUTCOME_ENTRY, outcome);
      return { content: [{ type: "text", text: "Recorded. You can stop now." }], details: outcome };
    },
  });

  pi.on("agent_before_settle", async (event: any) => {
    if (outcome) return; // finish_task was accepted: let it settle
    if (nudges >= MAX_NUDGES) {
      outcome = { outcome: "incomplete", summary: "" };
      pi.appendEntry(OUTCOME_ENTRY, outcome);
      return;
    }
    nudges++;
    return {
      entries: [...event.entries, { type: "custom_message", customType: "aelvyril-task-guard", content: NUDGE, display: false }],
      continue: true,
    };
  });
}
