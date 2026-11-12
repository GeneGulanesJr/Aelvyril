import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { GitHub } from "./github.ts";

/** A stand-in for github.com: records calls and answers by path. */
const fakeGitHub = () => {
  const calls: { url: string; body?: any }[] = [];
  let n = 0;
  const f = (async (u: string | URL, init?: RequestInit) => {
    const url = String(u);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status });
    if (url.endsWith("/login/oauth/access_token")) return json({ access_token: `tok${++n}`, expires_in: body.grant_type ? 3600 : 0.001, refresh_token: `ref${n}` });
    if (url.endsWith("/user")) return json({ login: "octo", avatar_url: "a.png" });
    if (url.includes("/user/installations?")) return json({ installations: [{ id: 7, app_slug: "my-app", account: { login: "octo" } }] });
    if (url.includes("/user/installations/7/repositories")) return json({ repositories: [{ full_name: "octo/b", private: true, default_branch: "main", html_url: "h" }, { full_name: "octo/a", private: false, default_branch: "dev", html_url: "h" }] });
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { f, calls };
};

test("github: sign in through the app, a token that refreshes itself, the repos it can see; kept private on disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aelv-gh-"));
  const { f, calls } = fakeGitHub();
  const gh = new GitHub({ dataDir: dir } as Config, { clientId: "Iv1", clientSecret: "s", fetch: f });
  const url = new URL(gh.authorizeUrl("http://localhost:3000/api/github/callback"));
  assert.equal(url.searchParams.get("client_id"), "Iv1");
  await assert.rejects(gh.finish("c", "wrong-state"), /expired/);
  await gh.finish("c", url.searchParams.get("state")!);
  assert.equal(calls[0].body.redirect_uri, "http://localhost:3000/api/github/callback", "the same callback it was sent to");
  assert.equal((statSync(join(dir, "github.json")).mode & 0o777).toString(8), "600");
  const st = await gh.status();
  assert.equal(st.login, "octo");
  assert.deepEqual(st.repos!.map((r) => r.full_name), ["octo/a", "octo/b"]);
  assert.equal(st.installUrl, "https://github.com/apps/my-app/installations/new", "the install link once the app's name is known");
  assert.ok(calls.some((c) => c.body?.grant_type === "refresh_token"), "the nearly expired token was refreshed");
  assert.equal(new GitHub({ dataDir: dir } as Config, { clientId: "Iv1", clientSecret: "s", fetch: f }).configured(), true);
  gh.disconnect();
  assert.equal((await gh.status()).connected, false);
  await assert.rejects(gh.token(), /isn't connected/);
});

test("github: an OAuth App asks for repo access in the one sign-in and lists every repo the person can reach", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aelv-gh-oauth-"));
  const calls: string[] = [];
  const f = (async (u: string | URL, init?: RequestInit) => {
    const url = String(u);
    calls.push(url);
    if (url.endsWith("/login/oauth/access_token")) return new Response(JSON.stringify({ access_token: "gho_x" }));
    if (url.endsWith("/user")) return new Response(JSON.stringify({ login: "octo" }));
    if (url.includes("/user/repos")) return new Response(JSON.stringify([{ full_name: "octo/a", private: true, default_branch: "main", html_url: "h" }]));
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const gh = new GitHub({ dataDir: dir } as Config, { clientId: "Ov23abc", clientSecret: "s", fetch: f });
  const url = new URL(gh.authorizeUrl("https://app.example/api/github/callback"));
  assert.equal(url.searchParams.get("scope"), "repo read:user");
  await gh.finish("c", url.searchParams.get("state")!);
  const st = await gh.status();
  assert.deepEqual(st.repos!.map((r) => r.full_name), ["octo/a"]);
  assert.ok(!calls.some((c) => c.includes("/installations")), "no install step to look for");
  assert.equal(await gh.token(), "gho_x", "an OAuth App token doesn't expire, so nothing to refresh");
});
