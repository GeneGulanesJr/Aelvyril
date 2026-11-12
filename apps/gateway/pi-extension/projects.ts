// Bundled pi extension (main conversation only): coding projects. Each project is an isolated sandbox with a git checkout;
// coding work on it goes to a task started with start_job's `project`, whose tools then run inside that sandbox.
// Not part of the gateway's typecheck: pi supplies "typebox" and the types when it loads this file.
import { Type } from "typebox";

const call = async (path: string, init: RequestInit = {}) => {
  const url = process.env.AELVYRIL_INTERNAL_URL;
  const token = process.env.AELVYRIL_INTERNAL_TOKEN;
  if (!url || !token) throw new Error("Projects are not available in this session.");
  const res = await fetch(`${url}${path}`, { ...init, headers: { "content-type": "application/json", "x-aelvyril-token": token, "x-aelvyril-thread": process.env.AELVYRIL_THREAD_ID ?? "" } });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? String(res.status));
  return data;
};
const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], details: {}, ...(isError ? { isError } : {}) });

export default function (pi: any) {
  pi.registerTool({
    name: "create_project",
    label: "Create a coding project",
    description:
      "Make a coding project: an isolated sandbox with its own copy of the code. Give repo as owner/name to copy one of the person's GitHub repos " +
      "(only repos the Aelvyril GitHub app can see; list_projects says if GitHub works), or leave it out for a new empty project. " +
      "Then start a job with start_job and project set to the returned id to do the coding.",
    promptSnippet: "Make an isolated coding project (from a GitHub repo or empty) for coding tasks",
    promptGuidelines: [
      "Coding on the person's code (a repo, an app, a website) always happens in a project: call list_projects, reuse the project for that code if there is one, otherwise create_project; then start_job with its project id.",
      "Never ask a job without a project to change code in a repo.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Short name, e.g. 'Portfolio site'" }),
      repo: Type.Optional(Type.String({ description: "GitHub repo as owner/name" })),
    }),
    async execute(_id: string, params: { name: string; repo?: string }) {
      try {
        const p = await call("/internal/projects", { method: "POST", body: JSON.stringify(params) });
        return text(`Project "${p.name}" is ready (id ${p.id})${p.repo ? `, a copy of ${p.repo} on the branch ${p.branch}` : ""}. Start a job with project "${p.id}" to work on it.`);
      } catch (e) {
        return text(`Could not create the project: ${(e as Error).message}`, true);
      }
    },
  });

  pi.registerTool({
    name: "list_projects",
    label: "List coding projects",
    description: "The coding projects there are (id, name, GitHub repo, branch, pull request).",
    parameters: Type.Object({}),
    async execute() {
      try {
        const d = await call("/internal/projects");
        if (!d.enabled) return text("Coding projects aren't set up on this Aelvyril.");
        if (!d.projects.length) return text("No coding projects yet.");
        return text(d.projects.map((p: any) => `- ${p.id}: ${p.name}${p.repo ? ` (${p.repo}, branch ${p.branch})` : " (no repo)"}${p.pr ? `, pull request ${p.pr}` : ""}`).join("\n"));
      } catch (e) {
        return text(`Could not list projects: ${(e as Error).message}`, true);
      }
    },
  });
}
