import type { Design } from "./design.ts";
import type { ScreenReport } from "./screen.ts";
import type { Panel } from "@aelvyril/ui-schema";

/** A card on the home screen the assistant set up (GET /api/widgets). `every`: minutes between reads, when it reads an address. */
export interface WidgetRow {
  id: string;
  title: string;
  panel: Panel;
  updated_at: number;
  error?: string;
  every?: number;
}

export interface ThreadRow {
  id: string;
  title: string;
  updated_at: number;
  running: boolean;
  waiting: number;
  /** "main" is the Stream, "job" is a background task, "chat" is an older plain chat. */
  kind: "main" | "job" | "chat";
  parent_id: string | null;
  /** What to show: needs_you | working | done | failed | stopped */
  status: "needs_you" | "working" | "done" | "failed" | "stopped";
  /** One line from the latest answer. */
  preview: string;
  /** Tasks only: the project (board) it belongs to. */
  board?: string;
}
export interface ModelRow {
  provider: string;
  id: string;
  name?: string;
}
export interface ProviderRow {
  id: string;
  name: string;
  apiKey: boolean;
  oauth: boolean;
  configured: boolean;
  source?: string;
  custom: boolean;
}
export interface CustomProvider {
  id: string;
  baseUrl: string;
  api: string;
  models: { id: string; name?: string }[];
  hasKey: boolean;
}
export interface ProvidersState {
  providers: ProviderRow[];
  custom: CustomProvider[];
  defaultModel: { provider: string; modelId: string } | null;
}
export interface ExtensionRow {
  source: string;
  name: string;
  builtin: boolean;
}
export type LoginEvent =
  | { n: number; type: "notify"; event: { type: string; message?: string; url?: string; instructions?: string; userCode?: string; verificationUri?: string; links?: { url: string; label?: string }[] } }
  | { n: number; type: "prompt"; id: string; prompt: { type: "text" | "secret" | "select" | "manual_code"; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] } }
  | { n: number; type: "prompt_cancelled"; id: string }
  | { n: number; type: "done" }
  | { n: number; type: "error"; message: string };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, [data?.error ?? data?.message ?? String(res.status), data?.detail].filter(Boolean).join("\n"));
  return data as T;
}

export const api = {
  setup: () => req<{ needsSetup: boolean; needsCode: boolean }>("GET", "/api/setup"),
  signUp: (email: string, password: string, name: string, setupCode: string) =>
    req("POST", "/api/auth/sign-up/email", { email, password, name }, setupCode.trim() ? { "x-setup-code": setupCode.trim() } : undefined),
  signIn: (email: string, password: string) => req("POST", "/api/auth/sign-in/email", { email, password }),
  signOut: () => req("POST", "/api/auth/sign-out", {}),
  main: () => req<ThreadRow>("GET", "/api/main"),
  threads: () => req<ThreadRow[]>("GET", "/api/threads"),
  createThread: () => req<ThreadRow>("POST", "/api/threads", {}),
  deleteThread: (id: string) => req("DELETE", `/api/threads/${id}`),
  moveTask: (id: string, board: string) => req<{ board: string }>("PATCH", `/api/threads/${id}`, { board }),
  prompt: (id: string, message: string) => req("POST", `/api/threads/${id}/prompt`, { message }),
  retry: (id: string) => req("POST", `/api/threads/${id}/retry`, {}),
  abort: (id: string) => req("POST", `/api/threads/${id}/abort`, {}),
  answer: (id: string, body: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }) => req("POST", `/api/threads/${id}/ui-response`, body),
  models: () => req<ModelRow[]>("GET", "/api/models"),
  setModel: (id: string, provider: string, modelId: string) => req("POST", `/api/threads/${id}/model`, { provider, modelId }),

  providers: () => req<ProvidersState>("GET", "/api/providers"),
  logout: (id: string) => req("POST", `/api/providers/${id}/logout`, {}),
  startLogin: (id: string, type: "api_key" | "oauth") => req<{ sessionId: string }>("POST", `/api/providers/${id}/login`, { type }),
  pollLogin: (sid: string, after: number) => req<{ events: LoginEvent[]; finished: boolean }>("GET", `/api/login/${sid}?after=${after}`),
  answerLogin: (sid: string, promptId: string, value: string) => req("POST", `/api/login/${sid}/answer`, { promptId, value }),
  cancelLogin: (sid: string) => req("DELETE", `/api/login/${sid}`),
  saveCustom: (id: string, body: { baseUrl: string; apiKey?: string; models: { id: string; name?: string }[] }) => req("PUT", `/api/custom-providers/${id}`, body),
  deleteCustom: (id: string) => req("DELETE", `/api/custom-providers/${id}`),
  setDefaultModel: (provider: string, modelId: string) => req("PUT", "/api/default-model", { provider, modelId }),
  design: () => req<Design>("GET", "/api/design"),
  widgets: () => req<WidgetRow[]>("GET", "/api/widgets"),
  github: () => req<GitHubStatus>("GET", "/api/github"),
  projects: () => req<{ enabled: boolean; projects: ProjectRow[] }>("GET", "/api/projects"),
  projectAction: (id: string, action: string) => req("POST", `/api/projects/${encodeURIComponent(id)}/${action}`),
  projectLog: (id: string) => req<{ log: string }>("GET", `/api/projects/${encodeURIComponent(id)}/log`),
  deleteProject: (id: string) => req("DELETE", `/api/projects/${encodeURIComponent(id)}`),
  githubConnect: () => req<{ url: string }>("GET", `/api/github/connect?origin=${encodeURIComponent(location.origin)}`),
  githubDisconnect: () => req("DELETE", "/api/github"),
  removeWidget: (id: string) => req("DELETE", `/api/widgets/${encodeURIComponent(id)}`),
  setDesign: (d: Design & { reset?: boolean }) => req<Design>("PUT", "/api/design", d),
  reportScreen: (r: ScreenReport) => req("PUT", "/api/screen", r),
  profile: () => req<{ assistantName: string; yourName: string }>("GET", "/api/profile"),
  setProfile: (p: { assistantName?: string; yourName?: string }) => req<{ assistantName: string; yourName: string }>("PUT", "/api/profile", p),
  extensions: () => req<ExtensionRow[]>("GET", "/api/extensions"),
  addExtension: (source: string) => req<{ ok: true; source: string }>("POST", "/api/extensions", { source }),
  updateExtensions: () => req<{ ok: boolean; changed: boolean; output: string }>("POST", "/api/extensions/update", {}),
  removeExtension: (source: string) => req("POST", "/api/extensions/remove", { source }),
};

export interface GitHubStatus {
  configured: boolean;
  connected: boolean;
  login?: string;
  avatar_url?: string;
  repos?: { full_name: string; private: boolean; default_branch: string; html_url: string }[];
  installUrl?: string;
  manageUrls?: { account: string; url: string }[];
  error?: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  repo?: string;
  branch: string;
  run?: { command: string; port: number };
  push?: { title: string; body: string; at: number };
  pr?: string;
  /** The preview's address, when it has an app. */
  preview?: string;
  status: { state: "running" | "stopped" | "missing" | "unknown"; cpu?: number; cpus?: number; memUsed?: number; memLimit?: number; disk?: number | null; app?: boolean; error?: string };
}
