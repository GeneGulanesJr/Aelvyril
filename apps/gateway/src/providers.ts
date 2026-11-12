import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";

type Json = Record<string, any>;
type Runtime = Awaited<ReturnType<(typeof import("@earendil-works/pi-coding-agent"))["ModelRuntime"]["create"]>>;

export interface ProviderRow {
  id: string;
  name: string;
  /** Can be connected with an API key. */
  apiKey: boolean;
  /** Can be connected with a subscription login (OAuth). */
  oauth: boolean;
  configured: boolean;
  /** Where the credential comes from ("stored", "environment", ...). Never the secret itself. */
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

/** What the browser sees of an interactive login (API key or OAuth). */
export type LoginEvent =
  | { n: number; type: "notify"; event: Json }
  | { n: number; type: "prompt"; id: string; prompt: Json }
  | { n: number; type: "prompt_cancelled"; id: string }
  | { n: number; type: "done" }
  | { n: number; type: "error"; message: string };

type WithoutN<T> = T extends unknown ? Omit<T, "n"> : never;

class LoginSession {
  readonly id = randomUUID();
  readonly events: LoginEvent[] = [];
  readonly ac = new AbortController();
  private prompts = new Map<string, { resolve(v: string): void; reject(e: Error): void }>();
  finished = false;

  push(e: WithoutN<LoginEvent>) {
    this.events.push({ ...e, n: this.events.length + 1 } as LoginEvent);
  }

  /** The `interaction` object pi's login flow drives. */
  interaction() {
    return {
      signal: this.ac.signal,
      notify: (event: Json) => this.push({ type: "notify", event }),
      prompt: (prompt: Json) =>
        new Promise<string>((resolve, reject) => {
          const id = randomUUID();
          this.prompts.set(id, { resolve, reject });
          // pi races a pasted code against its local callback server and aborts the prompt if the callback wins.
          prompt.signal?.addEventListener("abort", () => {
            if (this.prompts.delete(id)) {
              this.push({ type: "prompt_cancelled", id });
              reject(new Error("prompt cancelled"));
            }
          });
          const { signal: _s, ...plain } = prompt;
          this.push({ type: "prompt", id, prompt: plain });
        }),
    };
  }

  answer(promptId: string, value: string): boolean {
    const p = this.prompts.get(promptId);
    if (!p) return false;
    this.prompts.delete(promptId);
    p.resolve(value);
    return true;
  }

  cancel() {
    this.ac.abort();
    for (const p of this.prompts.values()) p.reject(new Error("cancelled"));
    this.prompts.clear();
  }
}

const ID = /^[a-z0-9][a-z0-9-]{1,38}$/;
const NO_KEY = "none";

/** Provider credentials, custom endpoints and the default model, kept in Aelvyril's own pi home. */
export class Providers {
  private cfg: Config;
  private onChange: () => void;
  private sessions = new Map<string, LoginSession>();

  constructor(cfg: Config, onChange: () => void) {
    this.cfg = cfg;
    this.onChange = onChange;
  }

  private get authPath() {
    return join(this.cfg.piHome, "auth.json");
  }
  private get modelsPath() {
    return join(this.cfg.piHome, "models.json");
  }
  private get settingsPath() {
    return join(this.cfg.piHome, "settings.json");
  }

  // pi's runtime is cheap to create and re-reads the files, so make a fresh one per operation.
  private async runtime(): Promise<Runtime> {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    return ModelRuntime.create({ authPath: this.authPath, modelsPath: this.modelsPath });
  }

  private readJson(path: string): Json {
    try {
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    } catch {
      return {};
    }
  }

  /** Atomic, owner-only write: a crash never leaves a half-written credentials file. */
  private writeJson(path: string, data: Json) {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  }

  // ---- listing -------------------------------------------------------------
  async list(): Promise<{ providers: ProviderRow[]; custom: CustomProvider[]; defaultModel: { provider: string; modelId: string } | null; taskModel: { provider: string; modelId: string } | null }> {
    const rt = await this.runtime();
    const customIds = new Set(Object.keys(this.readJson(this.modelsPath).providers ?? {}));
    const providers = rt.getProviders().map((p) => {
      const st = rt.getProviderAuthStatus(p.id);
      return {
        id: p.id,
        name: p.name,
        apiKey: !!p.auth?.apiKey?.login,
        oauth: !!p.auth?.oauth,
        configured: st.configured,
        source: st.source,
        custom: customIds.has(p.id),
      };
    });
    const s = this.readJson(this.settingsPath);
    return {
      providers,
      custom: this.customProviders(),
      defaultModel: s.defaultProvider && s.defaultModel ? { provider: s.defaultProvider, modelId: s.defaultModel } : null,
      taskModel: this.taskModel(),
    };
  }

  // ---- custom OpenAI-compatible endpoints (models.json) -------------------
  customProviders(): CustomProvider[] {
    const providers: Json = this.readJson(this.modelsPath).providers ?? {};
    return Object.entries(providers).map(([id, p]) => ({
      id,
      baseUrl: String(p.baseUrl ?? ""),
      api: String(p.api ?? "openai-completions"),
      models: (p.models ?? []).map((m: Json) => ({ id: String(m.id), name: m.name ? String(m.name) : undefined })),
      hasKey: !!p.apiKey && p.apiKey !== NO_KEY,
    }));
  }

  saveCustom(id: string, input: { baseUrl?: unknown; apiKey?: unknown; models?: unknown; api?: unknown }): string | null {
    if (!ID.test(id)) return "id must be 2-39 characters: lowercase letters, digits, dashes";
    let url: URL;
    try {
      url = new URL(String(input.baseUrl));
    } catch {
      return "base URL is not a valid URL";
    }
    if (!/^https?:$/.test(url.protocol)) return "base URL must start with http:// or https://";
    const models = (Array.isArray(input.models) ? input.models : [])
      .map((m: any) => ({ id: String(m?.id ?? "").trim(), name: m?.name ? String(m.name).trim() : undefined }))
      .filter((m) => m.id);
    if (!models.length) return "add at least one model id";
    const file = this.readJson(this.modelsPath);
    const providers: Json = (file.providers ??= {});
    const prev: Json = providers[id] ?? {};
    // Blank key = keep the stored one (the browser never receives it back).
    // pi treats a provider with no key as unusable, but local servers (LM Studio, Ollama) need none: store a placeholder.
    const key = (typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : prev.apiKey) ?? NO_KEY;
    providers[id] = {
      baseUrl: url.toString().replace(/\/$/, ""),
      api: String(input.api ?? prev.api ?? "openai-completions"),
      ...(key ? { apiKey: key } : {}),
      models: models.map((m) => ({ id: m.id, ...(m.name ? { name: m.name } : {}) })),
    };
    this.writeJson(this.modelsPath, file);
    this.onChange();
    return null;
  }

  deleteCustom(id: string): boolean {
    const file = this.readJson(this.modelsPath);
    if (!file.providers?.[id]) return false;
    delete file.providers[id];
    this.writeJson(this.modelsPath, file);
    this.onChange();
    return true;
  }

  // ---- default model (settings.json) --------------------------------------
  setDefaultModel(provider: string, modelId: string) {
    const s = this.readJson(this.settingsPath);
    this.writeJson(this.settingsPath, { ...s, defaultProvider: provider, defaultModel: modelId });
    this.onChange();
  }

  // ---- the AI for tasks (optional; empty = the same as chats). Our own keys in settings.json: pi keeps keys it doesn't know.
  taskModel(): { provider: string; modelId: string } | null {
    const s = this.readJson(this.settingsPath);
    return s.aelvyrilTaskProvider && s.aelvyrilTaskModel ? { provider: s.aelvyrilTaskProvider, modelId: s.aelvyrilTaskModel } : null;
  }

  setTaskModel(provider: string, modelId: string) {
    const { aelvyrilTaskProvider: _p, aelvyrilTaskModel: _m, ...s } = this.readJson(this.settingsPath);
    this.writeJson(this.settingsPath, provider && modelId ? { ...s, aelvyrilTaskProvider: provider, aelvyrilTaskModel: modelId } : s);
    this.onChange();
  }

  // ---- interactive login (API key or OAuth) --------------------------------
  async startLogin(providerId: string, type: "api_key" | "oauth"): Promise<LoginSession> {
    const rt = await this.runtime();
    const p = rt.getProvider(providerId);
    if (!p) throw new Error("unknown provider");
    if (type === "api_key" ? !p.auth?.apiKey?.login : !p.auth?.oauth) throw new Error(`${p.name} does not support that login type`);
    const s = new LoginSession();
    this.sessions.set(s.id, s);
    const expire = setTimeout(() => s.cancel(), 10 * 60_000);
    rt.login(providerId, type, s.interaction())
      .then(() => {
        s.push({ type: "done" });
        this.onChange();
      })
      .catch((e: Error) => s.push({ type: "error", message: s.ac.signal.aborted ? "cancelled" : e.message }))
      .finally(() => {
        s.finished = true;
        clearTimeout(expire);
        setTimeout(() => this.sessions.delete(s.id), 5 * 60_000).unref();
      });
    return s;
  }

  session(id: string): LoginSession | undefined {
    return this.sessions.get(id);
  }

  async logout(providerId: string) {
    const rt = await this.runtime();
    await rt.logout(providerId);
    this.onChange();
  }
}
