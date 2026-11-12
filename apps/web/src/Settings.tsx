import { useEffect, useRef, useState } from "preact/hooks";
import { IconBack, IconLeave } from "./icons.tsx";
import { applyDesign } from "./design.ts";
import { api, type CustomProvider, type ExtensionRow, type LoginEvent, type ModelRow, type ProviderRow, type ProvidersState, type GitHubStatus } from "./api.ts";

// Plain-language names and "where do I get a key" links for the providers most people use.
const POPULAR: Record<string, { title: string; blurb: string; keyUrl?: string }> = {
  anthropic: { title: "Claude", blurb: "By Anthropic", keyUrl: "https://console.anthropic.com/settings/keys" },
  openai: { title: "ChatGPT models", blurb: "By OpenAI", keyUrl: "https://platform.openai.com/api-keys" },
  "openai-codex": { title: "ChatGPT subscription", blurb: "Sign in with your ChatGPT account" },
  google: { title: "Gemini", blurb: "By Google", keyUrl: "https://aistudio.google.com/apikey" },
  openrouter: { title: "OpenRouter", blurb: "Many models with one account", keyUrl: "https://openrouter.ai/keys" },
  "github-copilot": { title: "GitHub Copilot", blurb: "Use your Copilot subscription" },
  xai: { title: "Grok", blurb: "By xAI" },
  deepseek: { title: "DeepSeek", blurb: "Low-cost models", keyUrl: "https://platform.deepseek.com/api_keys" },
  mistral: { title: "Mistral", blurb: "European models", keyUrl: "https://console.mistral.ai/api-keys" },
  groq: { title: "Groq", blurb: "Very fast open models", keyUrl: "https://console.groq.com/keys" },
};

export function Settings({ initialTab = "models", onBack, onSignOut }: { initialTab?: "models" | "extensions" | "github" | "assistant"; onBack(): void; onSignOut(): void }) {
  const [tab, setTab] = useState(initialTab);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => back.current?.focus({ preventScroll: true }), []);
  return (
    <div class="settings">
      <header class="bar">
        <button ref={back} class="link back" onClick={onBack}><IconBack />Back</button>
        <span class="grow" />
        <button class="link" onClick={onSignOut}><IconLeave />Sign out</button>
      </header>
      <h2>Settings</h2>
      <div class="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "models"} class={tab === "models" ? "on" : ""} onClick={() => setTab("models")}>AI models</button>
        <button role="tab" aria-selected={tab === "extensions"} class={tab === "extensions" ? "on" : ""} onClick={() => setTab("extensions")}>Extensions</button>
        <button role="tab" aria-selected={tab === "github"} class={tab === "github" ? "on" : ""} onClick={() => setTab("github")}>GitHub</button>
        <button role="tab" aria-selected={tab === "assistant"} class={tab === "assistant" ? "on" : ""} onClick={() => setTab("assistant")}>Your assistant</button>
      </div>
      {tab === "models" ? <ModelsTab /> : tab === "extensions" ? <ExtensionsTab /> : tab === "github" ? <GitHubTab /> : <AssistantTab />}
    </div>
  );
}

// ---------------------------------------------------------------- GitHub
/** Connect GitHub through the GitHub App, and see the repos Aelvyril can work on. */
function GitHubTab() {
  const [st, setSt] = useState<GitHubStatus | null>(null);
  const [error, setError] = useState(() => {
    const r = new URLSearchParams(location.search).get("github");
    return r && r !== "connected" ? r : "";
  });
  const load = () => api.github().then(setSt).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    if (new URLSearchParams(location.search).has("github")) history.replaceState(null, "", location.pathname + location.hash);
  }, []);
  const connect = () => api.githubConnect().then((r) => location.assign(r.url), (e) => setError(e.message));
  return (
    <section class="card">
      <h3>GitHub</h3>
      <p class="muted small">Connect your GitHub account so Aelvyril can work on your repos. Its coding tasks work on a branch and open a pull request for you to review; your GitHub login stays with Aelvyril itself, never inside a task's sandbox.</p>
      {error && <p class="notice error">{error}</p>}
      {!st ? (
        <p class="muted">Loading…</p>
      ) : !st.configured ? (
        <p class="muted">GitHub isn't set up on this Aelvyril yet (it needs the GitHub App's ID and secret).</p>
      ) : !st.connected ? (
        <>
          <button class="btn primary" onClick={connect}>Connect GitHub</button>
          <p class="muted small">If GitHub says "the redirect_uri is not associated with this application", this address isn't in the GitHub App's callback URLs yet: add <code>{location.origin}/api/github/callback</code> under Callback URL in the app's settings on github.com, then try again.</p>
        </>
      ) : (
        <>
          <ProviderLine title={st.login ?? "GitHub"} note="Connected">
            <Confirm label="Disconnect" confirm="Disconnect?" onYes={async () => { await api.githubDisconnect().catch((e) => setError(e.message)); load(); }} />
          </ProviderLine>
          {st.error && <p class="notice error">{st.error}</p>}
          <h4>Repos it can work on</h4>
          {st.repos?.length ? (
            <ul class="gh-repos">
              {st.repos.map((r) => <li key={r.full_name}><a href={r.html_url} target="_blank" rel="noreferrer">{r.full_name}</a>{r.private && <span class="muted small"> · private</span>}</li>)}
            </ul>
          ) : (
            <p class="muted small">None yet: the app is signed in but not installed. On github.com open <a href="https://github.com/settings/apps" target="_blank" rel="noreferrer">your GitHub Apps</a>, pick this app, choose <strong>Install App</strong> and select the repos, then come back here.</p>
          )}
          <p class="row">
            {st.installUrl && <a class="btn" href={st.installUrl} target="_blank" rel="noreferrer">Add repos or accounts</a>}
            {st.manageUrls?.map((m) => <a key={m.url} class="link" href={m.url} target="_blank" rel="noreferrer">Change repos for {m.account}</a>)}
          </p>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- your assistant
function AssistantTab() {
  const [name, setName] = useState("");
  const [you, setYou] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [lookReset, setLookReset] = useState(false);
  useEffect(() => {
    api.profile().then((p) => (setName(p.assistantName), setYou(p.yourName), setLoaded(true))).catch((e) => setError((e as Error).message));
  }, []);
  const save = async (e: Event) => {
    e.preventDefault();
    setError("");
    setSaved("");
    try {
      const p = await api.setProfile({ assistantName: name, yourName: you });
      setName(p.assistantName);
      setYou(p.yourName);
      setSaved("Saved. It uses the new names from its next answer.");
    } catch (x) {
      setError((x as Error).message);
    }
  };
  return (
    <form class="stack" onSubmit={save}>
      <section class="card">
        <h3>Names</h3>
        <label class="field">
          <span>What should your assistant be called?</span>
          <input value={name} maxLength={40} placeholder="Aelvyril" disabled={!loaded} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>What should it call you?</span>
          <input value={you} maxLength={40} placeholder="Your name (optional)" autocomplete="off" disabled={!loaded} onInput={(e) => setYou(e.currentTarget.value)} />
          <span class="muted small">Only your assistant sees these. They stay on this computer.</span>
        </label>
        {error && <div class="notice error">{error}</div>}
        {saved && <p class="tone-success">{saved}</p>}
        <div class="row"><button class="btn primary" type="submit" disabled={!loaded}>Save</button></div>
      </section>
      <section class="card">
        <h3>How it looks</h3>
        <p class="muted small">Ask your assistant in the chat to change the colours, for example "make it green". You can put the original look back here.</p>
        <div class="row">
          <button
            class="btn"
            type="button"
            onClick={() =>
              api.setDesign({ reset: true }).then(
                () => (applyDesign({}), dispatchEvent(new Event("aelvyril-design")), setLookReset(true)),
                (x) => setError((x as Error).message),
              )
            }
          >
            Back to the original look
          </button>
          {lookReset && <span class="tone-success">The original look is back.</span>}
        </div>
      </section>
    </form>
  );
}

// ---------------------------------------------------------------- AI models
function ModelsTab() {
  const [state, setState] = useState<ProvidersState | null>(null);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [connect, setConnect] = useState<{ provider: ProviderRow; type: "api_key" | "oauth" } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState("");
  const [saved, setSaved] = useState("");
  const [taskSaved, setTaskSaved] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const st = await api.providers();
      setState(st);
      setModelsLoading(true);
      // Right after a change pi may need a moment: ask again a few times while something is connected.
      const anyConnected = st.providers.some((p) => p.configured);
      let list: ModelRow[] = [];
      for (let i = 0; i < (anyConnected ? 6 : 1); i++) {
        list = await api.models().catch(() => []);
        if (list.length) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      setModels(list);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setModelsLoading(false);
    }
  };
  useEffect(() => void load(), []);
  if (!state) return <p class="muted">{error || "Loading…"}</p>;

  const connected = state.providers.filter((p) => p.configured && !p.custom);
  const popular = Object.keys(POPULAR).map((id) => state.providers.find((p) => p.id === id)).filter((p): p is ProviderRow => !!p && !p.configured);
  const others = state.providers.filter((p) => !p.configured && !p.custom && !(p.id in POPULAR) && p.name.toLowerCase().includes(filter.toLowerCase()));
  const current = state.defaultModel ? `${state.defaultModel.provider}/${state.defaultModel.modelId}` : "";
  const forTasks = state.taskModel ? `${state.taskModel.provider}/${state.taskModel.modelId}` : "";

  return (
    <div class="stack">
      {error && <div class="notice error">{error}</div>}

      <section class="card">
        <h3>The AI your new chats use</h3>
        {modelsLoading && models.length === 0 ? (
          <p class="muted">Loading your AIs…</p>
        ) : models.length === 0 ? (
          <p class="muted">Connect an AI below, then pick it here.</p>
        ) : (
          <div class="row">
            <select
              value={current}
              onChange={async (e) => {
                const [provider, ...rest] = e.currentTarget.value.split("/");
                if (!provider) return;
                await api.setDefaultModel(provider, rest.join("/")).catch((err) => setError(err.message));
                setSaved("Saved. New chats will use it.");
                load();
              }}
            >
              <option value="">Choose…</option>
              {models.map((m) => <option value={`${m.provider}/${m.id}`}>{label(state, m)}</option>)}
            </select>
            {saved && <span class="tone-success">{saved}</span>}
          </div>
        )}
        {models.length > 0 && (
          <>
            <h3>AI for tasks (optional)</h3>
            <p class="muted">Tasks are the longer jobs the assistant does in the background. They can use a different AI, for example a stronger one.</p>
            <div class="row">
              <select
                aria-label="AI for tasks"
                value={forTasks}
                onChange={async (e) => {
                  const [provider, ...rest] = e.currentTarget.value.split("/");
                  await api.setTaskModel(provider ?? "", rest.join("/")).catch((err) => setError(err.message));
                  setTaskSaved(provider ? "Saved. Tasks will use it." : "Saved. Tasks will use the same AI as chats.");
                  load();
                }}
              >
                <option value="">Same as chats</option>
                {models.map((m) => <option value={`${m.provider}/${m.id}`}>{label(state, m)}</option>)}
              </select>
              {taskSaved && <span class="tone-success">{taskSaved}</span>}
            </div>
          </>
        )}
      </section>

      {(connected.length > 0 || state.custom.length > 0) && (
        <section class="card">
          <h3>Connected</h3>
          {connected.map((p) => (
            <ProviderLine key={p.id} title={POPULAR[p.id]?.title ?? p.name} note={p.source === "environment" ? "Set up on the server" : "Connected"}>
              {p.source === "stored" && <Confirm label="Disconnect" confirm="Disconnect?" onYes={async () => { await api.logout(p.id).catch((e) => setError(e.message)); load(); }} />}
            </ProviderLine>
          ))}
          {state.custom.map((c) => (
            <ProviderLine key={c.id} title={c.id} note={`Your own server · ${c.baseUrl}`}>
              <Confirm label="Remove" confirm="Remove?" onYes={async () => { await api.deleteCustom(c.id).catch((e) => setError(e.message)); load(); }} />
            </ProviderLine>
          ))}
        </section>
      )}

      <section class="card">
        <h3>Add an AI</h3>
        <p class="muted">Pick the one you already have an account with. You can connect more than one.</p>
        {popular.map((p) => (
          <ProviderLine key={p.id} title={POPULAR[p.id].title} note={POPULAR[p.id].blurb}>
            {p.oauth && <button class="btn primary" onClick={() => setConnect({ provider: p, type: "oauth" })}>Sign in</button>}
            {p.apiKey && <button class={`btn ${p.oauth ? "" : "primary"}`} onClick={() => setConnect({ provider: p, type: "api_key" })}>Use an API key</button>}
          </ProviderLine>
        ))}
        <button class="link" onClick={() => setShowAll(!showAll)}>{showAll ? "Hide other providers" : "Show more providers"}</button>
        {showAll && (
          <div class="stack">
            <input placeholder="Search providers" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} />
            {others.map((p) => (
              <ProviderLine key={p.id} title={p.name}>
                {p.oauth && <button class="btn" onClick={() => setConnect({ provider: p, type: "oauth" })}>Sign in</button>}
                {p.apiKey && <button class="btn" onClick={() => setConnect({ provider: p, type: "api_key" })}>Use an API key</button>}
              </ProviderLine>
            ))}
          </div>
        )}
      </section>

      <CustomServer existing={state.custom} onSaved={load} />

      {connect && (
        <ConnectDialog
          provider={connect.provider}
          type={connect.type}
          keyUrl={POPULAR[connect.provider.id]?.keyUrl}
          onClose={() => { setConnect(null); load(); }}
        />
      )}
    </div>
  );
}

const label = (s: ProvidersState, m: ModelRow) => `${POPULAR[m.provider]?.title ?? s.providers.find((p) => p.id === m.provider)?.name ?? m.provider} · ${m.name ?? m.id}`;

function ProviderLine({ title, note, children }: { title: string; note?: string; children?: preact.ComponentChildren }) {
  return (
    <div class="provider-line">
      <div>
        <strong>{title}</strong>
        {note && <div class="muted small">{note}</div>}
      </div>
      <div class="row">{children}</div>
    </div>
  );
}

/** Two-step button so nothing is removed by one stray click. */
function Confirm({ label, confirm, onYes }: { label: string; confirm: string; onYes(): void }) {
  const [asking, setAsking] = useState(false);
  return asking ? (
    <span class="row">
      <button class="btn danger" onClick={onYes}>{confirm}</button>
      <button class="link" onClick={() => setAsking(false)}>Cancel</button>
    </span>
  ) : (
    <button class="btn" onClick={() => setAsking(true)}>{label}</button>
  );
}

// ------------------------------------------------- connecting (key or sign-in)
function ConnectDialog({ provider, type, keyUrl, onClose }: { provider: ProviderRow; type: "api_key" | "oauth"; keyUrl?: string; onClose(): void }) {
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [attempt, setAttempt] = useState(0);
  const [startError, setStartError] = useState("");
  const sid = useRef("");

  useEffect(() => {
    let stop = false;
    let last = 0;
    setEvents([]);
    setAnswered(new Set());
    setStartError("");
    (async () => {
      try {
        sid.current = (await api.startLogin(provider.id, type)).sessionId;
      } catch (e) {
        return setStartError((e as Error).message);
      }
      while (!stop) {
        const r = await api.pollLogin(sid.current, last).catch(() => null);
        if (r?.events.length) {
          last = r.events[r.events.length - 1].n;
          setEvents((s) => [...s, ...r.events]);
        }
        if (r?.finished) break;
        await new Promise((res) => setTimeout(res, 600));
      }
    })();
    return () => {
      stop = true;
      if (sid.current) api.cancelLogin(sid.current).catch(() => {});
    };
  }, [attempt]);

  const done = events.some((e) => e.type === "done");
  const failed = events.find((e): e is Extract<LoginEvent, { type: "error" }> => e.type === "error");
  const cancelled = new Set(events.filter((e) => e.type === "prompt_cancelled").map((e) => (e as { id: string }).id));
  const pending = events.filter((e): e is Extract<LoginEvent, { type: "prompt" }> => e.type === "prompt" && !answered.has(e.id) && !cancelled.has(e.id)).at(-1);
  const notices = events.filter((e): e is Extract<LoginEvent, { type: "notify" }> => e.type === "notify").map((e) => e.event);
  const authUrl = notices.find((n) => n.type === "auth_url");
  const device = notices.find((n) => n.type === "device_code");
  const progress = notices.filter((n) => n.type === "progress" || n.type === "info").at(-1);

  useEffect(() => {
    if (done) {
      const t = setTimeout(onClose, 1200);
      return () => clearTimeout(t);
    }
  }, [done]);

  const title = POPULAR[provider.id]?.title ?? provider.name;
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" role="dialog" aria-label={`Connect ${title}`}>
        <h3>{type === "oauth" ? `Sign in to ${title}` : `Connect ${title}`}</h3>
        {startError && <div class="notice error">{startError}</div>}
        {done && <p class="tone-success"><strong>Connected ✓</strong></p>}
        {failed && !done && (
          <div class="stack">
            <div class="notice error">{failed.message === "cancelled" ? "Cancelled." : failed.message}</div>
            <button class="btn primary" onClick={() => setAttempt((a) => a + 1)}>Try again</button>
          </div>
        )}
        {!done && !failed && !startError && (
          <div class="stack">
            {authUrl?.url && (
              <div class="stack">
                <p><strong>Step 1.</strong> Open the sign-in page and log in.</p>
                <a class="btn primary" href={authUrl.url} target="_blank" rel="noopener noreferrer">Open sign-in page</a>
                {authUrl.instructions && <p class="muted small">{authUrl.instructions}</p>}
              </div>
            )}
            {device && (
              <div class="stack">
                <p><strong>Your code:</strong></p>
                <div class="code">{device.userCode}</div>
                <a class="btn primary" href={device.verificationUri} target="_blank" rel="noopener noreferrer">Open the page and enter the code</a>
              </div>
            )}
            {pending && (
              <PromptForm
                key={pending.id}
                prompt={pending.prompt}
                keyUrl={type === "api_key" ? keyUrl : undefined}
                afterLink={!!authUrl}
                onAnswer={async (v) => {
                  await api.answerLogin(sid.current, pending.id, v).catch(() => {});
                  setAnswered((s) => new Set(s).add(pending.id));
                }}
              />
            )}
            {!pending && !authUrl && !device && <p class="muted">{progress?.message ?? "Working…"}</p>}
            {!pending && (authUrl || device) && <p class="muted">Waiting for you to finish signing in…</p>}
          </div>
        )}
        <div class="row end">
          <button class="link" onClick={onClose}>{done ? "Close" : "Cancel"}</button>
        </div>
      </div>
    </div>
  );
}

function PromptForm({ prompt, keyUrl, afterLink, onAnswer }: { prompt: Extract<LoginEvent, { type: "prompt" }>["prompt"]; keyUrl?: string; afterLink: boolean; onAnswer(v: string): void }) {
  const [v, setV] = useState("");
  if (prompt.type === "select") {
    return (
      <div class="stack">
        <p>{prompt.message}</p>
        {prompt.options?.map((o) => (
          <button class="btn" onClick={() => onAnswer(o.id)}>
            {o.label}
            {o.description && <div class="muted small">{o.description}</div>}
          </button>
        ))}
      </div>
    );
  }
  const manual = prompt.type === "manual_code";
  return (
    <form class="stack" onSubmit={(e) => { e.preventDefault(); if (v.trim()) onAnswer(v.trim()); }}>
      {manual ? (
        <p>
          <strong>{afterLink ? "Step 2." : ""}</strong> When you finish signing in, your browser may show an error page. That's fine: copy the <em>full address</em> from the address bar and paste it here.
        </p>
      ) : (
        <p>{prompt.message}</p>
      )}
      {keyUrl && <a href={keyUrl} target="_blank" rel="noopener noreferrer">Where do I get a key?</a>}
      <input
        type={prompt.type === "secret" ? "password" : "text"}
        autocomplete="off"
        autofocus
        placeholder={manual ? "Paste the address here" : prompt.placeholder ?? ""}
        value={v}
        onInput={(e) => setV(e.currentTarget.value)}
      />
      {prompt.type === "secret" && <p class="muted small">Your key is stored only on this computer, inside Aelvyril's data folder. It is never shown again.</p>}
      <button class="btn primary" type="submit" disabled={!v.trim()}>{manual ? "Finish" : "Save"}</button>
    </form>
  );
}

// ------------------------------------------------------- your own AI server
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function CustomServer({ existing, onSaved }: { existing: CustomProvider[]; onSaved(): void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [modelText, setModelText] = useState("");
  const [err, setErr] = useState("");
  const edit = (c: CustomProvider) => {
    setOpen(true);
    setName(c.id);
    setUrl(c.baseUrl);
    setKey("");
    setModelText(c.models.map((m) => m.id).join(", "));
  };
  const submit = async (e: Event) => {
    e.preventDefault();
    setErr("");
    try {
      const models = modelText.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((id) => ({ id }));
      await api.saveCustom(slug(name), { baseUrl: url, apiKey: key || undefined, models });
      setOpen(false);
      setName(""); setUrl(""); setKey(""); setModelText("");
      onSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  };
  return (
    <section class="card">
      <h3>Use your own AI server</h3>
      <p class="muted">For programs like LM Studio or Ollama, or any service that works like OpenAI's.</p>
      {existing.map((c) => <div class="muted small">{c.id}: <button class="link" onClick={() => edit(c)}>edit</button></div>)}
      {!open ? (
        <button class="btn" onClick={() => setOpen(true)}>Add a server</button>
      ) : (
        <form class="stack" onSubmit={submit}>
          <label class="field"><span>Name</span><input required placeholder="my-server" value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
          <label class="field">
            <span>Address</span>
            <input required placeholder="http://127.0.0.1:1234/v1" value={url} onInput={(e) => setUrl(e.currentTarget.value)} />
            <span class="muted small">If Aelvyril runs in Docker and the server runs on this computer, use <code>host.docker.internal</code> instead of <code>127.0.0.1</code>.</span>
          </label>
          <label class="field"><span>Key (leave empty if it doesn't need one)</span><input type="password" autocomplete="off" value={key} onInput={(e) => setKey(e.currentTarget.value)} /></label>
          <label class="field"><span>Model names (separate with commas)</span><input required placeholder="qwen2.5-7b-instruct" value={modelText} onInput={(e) => setModelText(e.currentTarget.value)} /></label>
          {err && <div class="notice error">{err}</div>}
          <div class="row">
            <button class="btn primary" type="submit">Save</button>
            <button class="link" type="button" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}

// -------------------------------------------------------------- extensions
function ExtensionsTab() {
  const [list, setList] = useState<ExtensionRow[] | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [checking, setChecking] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<{ good: boolean; text: string } | null>(null);
  const checkUpdates = async () => {
    setChecking(true);
    setUpdateMsg(null);
    try {
      const r = await api.updateExtensions();
      setUpdateMsg(!r.ok ? { good: false, text: "Couldn't check for updates. Are you online?" } : r.changed ? { good: true, text: "Updated. Your assistant uses the new versions from its next answer." } : { good: true, text: "Everything is up to date." });
    } catch (e) {
      setUpdateMsg({ good: false, text: (e as Error).message });
    } finally {
      setChecking(false);
    }
  };
  const load = () => api.extensions().then(setList).catch((e) => setError(e.message));
  useEffect(() => void load(), []);

  const add = async (e: Event) => {
    e.preventDefault();
    setError("");
    setOk("");
    setBusy(true);
    try {
      await api.addExtension(input);
      setInput("");
      setOk("Added. It's ready in your next message.");
      await load();
    } catch (e2) {
      setError((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="stack">
      <section class="card">
        <h3>Installed</h3>
        <p class="muted">Extensions give Aelvyril new abilities, like remembering things or splitting big jobs into smaller ones.</p>
        {list === null && <p class="muted">Loading…</p>}
        {list?.length === 0 && <p class="muted">Nothing installed yet.</p>}
        {list?.map((x) => (
          <ProviderLine key={x.source} title={x.name} note={x.builtin ? "Included with Aelvyril" : x.source}>
            {x.builtin ? (
              <button class="btn" disabled title="Part of how Aelvyril works">Remove</button>
            ) : (
              <Confirm label="Remove" confirm="Remove?" onYes={async () => { await api.removeExtension(x.source).catch((e) => setError(e.message)); load(); }} />
            )}
          </ProviderLine>
        ))}
      </section>
      <section class="card">
        <h3>Updates</h3>
        <p class="muted small">Your extensions update by themselves once a day. You can also check now.</p>
        <div class="row">
          <button class="btn" type="button" disabled={checking} onClick={checkUpdates}>{checking ? "Checking…" : "Check for updates"}</button>
          {updateMsg && <span class={updateMsg.good ? "tone-success" : "tone-error"}>{updateMsg.text}</span>}
        </div>
      </section>

      <section class="card">
        <h3>Add an extension</h3>
        <form class="stack" onSubmit={add}>
          <input required disabled={busy} placeholder="Paste a GitHub link, like https://github.com/name/extension" value={input} onInput={(e) => setInput(e.currentTarget.value)} />
          <p class="notice warning small">Extensions are programs. They can read and change files that Aelvyril can reach. Only add ones from people you trust.</p>
          <div class="row">
            <button class="btn primary" type="submit" disabled={busy || !input.trim()}>{busy ? "Installing… this can take a minute" : "Add"}</button>
          </div>
        </form>
        {ok && <div class="notice">{ok}</div>}
        {error && <pre class="notice error">{error}</pre>}
      </section>
    </div>
  );
}
