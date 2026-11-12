// Bundled pi extension: lets the main conversation hand real work to a background job.
// Loaded only into the main conversation's pi process (see Supervisor.ensureHost).
// Not part of the gateway's typecheck: pi supplies "typebox" and the types when it loads this file.
import { Type } from "typebox";

export default function (pi: any) {
  pi.registerTool({
    name: "start_job",
    label: "Start a job",
    description:
      "Start a background job that can use tools (read and change files, run commands, research in several steps). " +
      "Use it for anything that is more than a quick answer. The job runs on its own and the user is told when it is done.",
    promptSnippet: "Hand real work to a background job instead of doing it in this conversation",
    promptGuidelines: [
      "Use start_job for any request that needs tools, files, commands or several steps; answer quick questions directly without it.",
      "After start_job returns, tell the user in one friendly sentence that the job has started and that you are free for the next question.",
      "Every task goes on a board (a project). Give related tasks the same board name (for example every task about the weather widget on 'Weather'); start a new board only for a new project. The result of start_job lists the boards there are.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "A short plain-language name for the job, under 60 characters" }),
      task: Type.String({ description: "Everything the job needs to know, written so it makes sense on its own" }),
      board: Type.Optional(Type.String({ description: "The project board it belongs on, e.g. 'Weather'. Reuse an existing board's name for related work; a short new name for a new project." })),
      project: Type.Optional(Type.String({ description: "A coding project id (from create_project / list_projects): the job then works inside that project's isolated sandbox. Required for any work on code." })),
    }),
    async execute(_id: string, params: { title: string; task: string; board?: string; project?: string }) {
      const url = process.env.AELVYRIL_INTERNAL_URL;
      const token = process.env.AELVYRIL_INTERNAL_TOKEN;
      const threadId = process.env.AELVYRIL_THREAD_ID;
      if (!url || !token || !threadId) {
        return { content: [{ type: "text", text: "Jobs are not available in this session." }], details: {}, isError: true };
      }
      try {
        const res = await fetch(`${url}/internal/jobs`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-aelvyril-token": token },
          body: JSON.stringify({ threadId, title: params.title, task: params.task, board: params.board ?? "", project: params.project ?? "" }),
        });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok) return { content: [{ type: "text", text: `Could not start the job: ${data.error ?? res.status}` }], details: {}, isError: true };
        return { content: [{ type: "text", text: `Job "${params.title}" started on the board "${data.board}". It runs in the background. Boards there are: ${(data.boards ?? []).join(", ")}.` }], details: { jobId: data.jobId, board: data.board } };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not start the job: ${(e as Error).message}` }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "continue_job",
    label: "Send a task back",
    description:
      "Send a finished task back to work because something that was asked for is clearly missing from its result. " +
      "Use the task id from the finished-task message. At most twice per task; after that, tell the user what is missing instead.",
    promptSnippet: "Send a finished task back when its result is missing something that was asked for",
    parameters: Type.Object({
      id: Type.String({ description: "The task id, from the message that said the task finished" }),
      missing: Type.String({ description: "What was asked for but is missing from the result, said plainly" }),
    }),
    async execute(_id: string, params: { id: string; missing: string }) {
      const url = process.env.AELVYRIL_INTERNAL_URL;
      if (!url) return { content: [{ type: "text", text: "Jobs are not available in this session." }], details: {}, isError: true };
      try {
        const res = await fetch(`${url}/internal/jobs/${encodeURIComponent(params.id)}/continue`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-aelvyril-token": process.env.AELVYRIL_INTERNAL_TOKEN ?? "", "x-aelvyril-thread": process.env.AELVYRIL_THREAD_ID ?? "" },
          body: JSON.stringify({ instruction: params.missing }),
        });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok) return { content: [{ type: "text", text: `Could not send the task back: ${data.error ?? res.status}` }], details: {}, isError: true };
        return { content: [{ type: "text", text: "Sent back. The task is working again; its new result will come back here." }], details: { jobId: params.id } };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not send the task back: ${(e as Error).message}` }], details: {}, isError: true };
      }
    },
  });
}
