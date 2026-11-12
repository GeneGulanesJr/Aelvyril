// The person's GitHub account. With a GitHub OAuth App (the setup Aelvyril uses), one sign-in gives it every repo the person
// can reach; with a GitHub App (client id "Iv…"), only the repos it is installed on. The token lives here, in the gateway's data folder; coding sandboxes never get it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Config } from "./config.ts";

interface Saved {
  access_token: string;
  /** Present when the app expires user tokens (8 h), with a refresh token good for months. */
  expires_at?: number;
  refresh_token?: string;
  login: string;
  avatar_url?: string;
}
export interface Repo {
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
}
export interface GitHubStatus {
  /** The app's ID and secret are set (AELVYRIL_GITHUB_CLIENT_ID / _SECRET). */
  configured: boolean;
  connected: boolean;
  login?: string;
  avatar_url?: string;
  repos?: Repo[];
  /** Where to install the app on more accounts, or change which repos it can see. */
  installUrl?: string;
  manageUrls?: { account: string; url: string }[];
  error?: string;
}

const API = "https://api.github.com";
const STATE_TTL = 10 * 60_000;

export class GitHub {
  private file: string;
  private saved: Saved | null = null;
  private states = new Map<string, { redirectUri: string; at: number }>();
  private doFetch: typeof fetch;
  private clientId: string;
  private clientSecret: string;
  /** Learned from an installation; the install link needs it. */
  private slug = "";

  constructor(cfg: Config, opts: { clientId?: string; clientSecret?: string; fetch?: typeof fetch } = {}) {
    this.file = join(cfg.dataDir, "github.json");
    this.clientId = opts.clientId ?? process.env.AELVYRIL_GITHUB_CLIENT_ID ?? "";
    this.clientSecret = opts.clientSecret ?? process.env.AELVYRIL_GITHUB_CLIENT_SECRET ?? "";
    this.slug = process.env.AELVYRIL_GITHUB_APP_SLUG ?? "";
    this.doFetch = opts.fetch ?? fetch;
    try {
      if (existsSync(this.file)) {
        const s = JSON.parse(readFileSync(this.file, "utf8"));
        if (s?.access_token && s?.login) this.saved = s;
      }
    } catch {
      // a damaged file just means signed out
    }
  }

  configured() {
    return !!(this.clientId && this.clientSecret);
  }

  /** GitHub App client ids start with "Iv"; anything else is an OAuth App (repo access by scope, no install step). */
  private get oauthApp() {
    return !this.clientId.startsWith("Iv");
  }

  /** The GitHub page to send the person to; `redirectUri` must be one of the app's callback URLs. */
  authorizeUrl(redirectUri: string) {
    if (!this.configured()) throw new Error("GitHub isn't set up on this Aelvyril (no app ID and secret).");
    const now = Date.now();
    for (const [k, v] of this.states) if (now - v.at > STATE_TTL) this.states.delete(k);
    const state = randomBytes(16).toString("hex");
    this.states.set(state, { redirectUri, at: now });
    return `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: this.clientId, redirect_uri: redirectUri, state, ...(this.oauthApp ? { scope: "repo read:user" } : {}) })}`;
  }

  /** GitHub sent the person back: swaps the code for a token and remembers who they are. */
  async finish(code: string, state: string) {
    const s = this.states.get(state);
    this.states.delete(state);
    if (!s || Date.now() - s.at > STATE_TTL) throw new Error("That sign-in link expired. Try connecting again.");
    const t = await this.tokenCall({ code, redirect_uri: s.redirectUri });
    const me = await this.api<{ login: string; avatar_url?: string }>("/user", t.access_token);
    this.save({ ...t, login: me.login, avatar_url: me.avatar_url });
  }

  disconnect() {
    this.saved = null;
    writeFileSync(this.file, "{}", { mode: 0o600 });
  }

  /** A working token, refreshed when it is about to expire. Throws when signed out. */
  async token(): Promise<string> {
    const s = this.saved;
    if (!s) throw new Error("GitHub isn't connected.");
    if (s.expires_at && s.refresh_token && s.expires_at - Date.now() < 60_000) {
      const t = await this.tokenCall({ grant_type: "refresh_token", refresh_token: s.refresh_token });
      this.save({ ...s, ...t });
    }
    return this.saved!.access_token;
  }

  async status(): Promise<GitHubStatus> {
    const base: GitHubStatus = { configured: this.configured(), connected: !!this.saved };
    if (!this.saved) return { ...base, installUrl: this.installUrl() };
    try {
      const tok = await this.token();
      if (this.oauthApp) {
        // shortcut: the 300 most recently pushed repos; page further when someone has more
        const repos: Repo[] = [];
        for (let page = 1; page <= 3; page++) {
          const r = await this.api<Repo[]>(`/user/repos?per_page=100&sort=pushed&page=${page}`, tok);
          repos.push(...r.map((x) => ({ full_name: x.full_name, private: x.private, default_branch: x.default_branch, html_url: x.html_url })));
          if (r.length < 100) break;
        }
        return { ...base, login: this.saved.login, avatar_url: this.saved.avatar_url, repos, manageUrls: [{ account: this.saved.login, url: `https://github.com/settings/connections/applications/${this.clientId}` }] };
      }
      const { installations } = await this.api<{ installations: { id: number; app_slug: string; account: { login: string } }[] }>("/user/installations?per_page=100", tok);
      if (installations[0]?.app_slug) this.slug = installations[0].app_slug;
      const repos: Repo[] = [];
      for (const i of installations) {
        // shortcut: first 100 repos per installation, page through when someone installs it on more
        const r = await this.api<{ repositories: Repo[] }>(`/user/installations/${i.id}/repositories?per_page=100`, tok);
        for (const x of r.repositories) repos.push({ full_name: x.full_name, private: x.private, default_branch: x.default_branch, html_url: x.html_url });
      }
      return {
        ...base,
        login: this.saved.login,
        avatar_url: this.saved.avatar_url,
        repos: repos.sort((a, b) => a.full_name.localeCompare(b.full_name)),
        installUrl: this.installUrl(),
        manageUrls: installations.map((i) => ({ account: i.account.login, url: `https://github.com/settings/installations/${i.id}` })),
      };
    } catch (e) {
      return { ...base, login: this.saved.login, error: (e as Error).message };
    }
  }

  /** One repo's name and default branch (it must be one the app can see). */
  async repo(fullName: string) {
    return this.api<{ full_name: string; default_branch: string }>(`/repos/${fullName}`, await this.token());
  }

  /** Environment for git that sends the token as a header, so it's never written into a remote URL or a config file. */
  async gitEnv(): Promise<NodeJS.ProcessEnv> {
    const basic = Buffer.from(`x-access-token:${await this.token()}`).toString("base64");
    return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`, GIT_TERMINAL_PROMPT: "0" };
  }

  /** Opens a pull request, or finds the one already open for that branch. Returns its address. */
  async openPr(fullName: string, pr: { title: string; body: string; head: string; base: string }): Promise<string> {
    const tok = await this.token();
    const res = await this.doFetch(`${API}/repos/${fullName}/pulls`, { method: "POST", headers: this.headers(tok), body: JSON.stringify(pr) });
    if (res.ok) return ((await res.json()) as { html_url: string }).html_url;
    if (res.status === 422) {
      const [owner] = fullName.split("/");
      const open = await this.api<{ html_url: string }[]>(`/repos/${fullName}/pulls?state=open&head=${encodeURIComponent(`${owner}:${pr.head}`)}`, tok);
      if (open[0]) return open[0].html_url;
    }
    throw new Error(`GitHub wouldn't open the pull request (${res.status}). The app may need "Pull requests: read and write" permission.`);
  }

  private headers(token: string) {
    return { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "Aelvyril", "content-type": "application/json" };
  }

  private installUrl() {
    return this.slug ? `https://github.com/apps/${this.slug}/installations/new` : undefined;
  }

  private save(t: { access_token: string; expires_in?: number; refresh_token?: string; login: string; avatar_url?: string; expires_at?: number }) {
    const s: Saved = { access_token: t.access_token, login: t.login, avatar_url: t.avatar_url, refresh_token: t.refresh_token, expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : t.expires_at };
    this.saved = s;
    writeFileSync(this.file, JSON.stringify(s), { mode: 0o600 });
  }

  private async tokenCall(params: Record<string, string>) {
    const res = await this.doFetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "Aelvyril" },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, ...params }),
    });
    const d = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
    if (!res.ok || !d.access_token) throw new Error(`GitHub refused: ${d.error_description ?? d.error ?? res.status}`);
    return { access_token: d.access_token, expires_in: d.expires_in, refresh_token: d.refresh_token };
  }

  private async api<T>(path: string, token: string): Promise<T> {
    const res = await this.doFetch(API + path, { headers: this.headers(token) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path.split("?")[0]}`);
    return (await res.json()) as T;
  }
}
