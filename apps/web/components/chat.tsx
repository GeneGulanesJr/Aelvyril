"use client";

import { UserButton, useAuth, useUser } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation, EventEnvelope } from "@aelvyril/shared";
import { GatewayClient } from "../lib/api";
import { filterConversations } from "../lib/filter-conversations";

interface UiMessage {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
}

export function Chat() {
  const { getToken, userId } = useAuth();
  const { user } = useUser();
  const [client, setClient] = useState<GatewayClient | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "streaming" | "degraded">("idle");
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const closeStream = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!getToken) return;
    setClient(new GatewayClient(process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787", getToken));
  }, [getToken]);

  const applyEnvelope = useCallback((env: EventEnvelope) => {
    setMessages((prev) => {
      switch (env.kind) {
        case "text_delta":
          setWaiting(false);
          return appendAssistant(prev, env.payload.delta);
        case "tool_call":
          setWaiting(false);
          return [...prev, { role: "tool", text: `⚙ ${env.payload.toolName}` }];
        case "user_message":
          return [...prev, { role: "user", text: env.payload.text }];
        case "tool_result":
          return prev;
        case "session_state":
          setStatus(env.payload.state === "streaming" ? "streaming" : env.payload.state === "degraded" ? "degraded" : "idle");
          if (env.payload.state !== "streaming") setWaiting(false);
          return env.payload.state === "restarted"
            ? [...prev, { role: "system", text: "agent restarted — context restored" }]
            : prev;
        case "error":
          setError(env.payload.message);
          setWaiting(false);
          return prev;
        default:
          return prev;
      }
    });
  }, []);

  const openConversation = useCallback(
    (id: string) => {
      closeStream.current?.();
      setActiveId(id);
      setMessages([]);
      setError(null);
      setWaiting(false);
      if (!client) return;
      closeStream.current = client.openStream(id, applyEnvelope);
    },
    [client, applyEnvelope],
  );

  const refreshList = useCallback(async () => {
    if (!client) return;
    setConversations(await client.listConversations());
  }, [client]);

  useEffect(() => {
    void refreshList();
    return () => closeStream.current?.();
  }, [refreshList]);

  // Keep the newest message (and the typing indicator) in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, waiting]);

  const send = useCallback(async () => {
    if (!client || !input.trim()) return;
    let id = activeId;
    if (!id) {
      const conv = await client.createConversation({});
      id = conv.id;
      setActiveId(id);
      openConversation(id);
    }
    // No local bubble: the gateway persists + echoes a user_message envelope
    // (seq-ordered), so sends survive conversation switches and reconnects.
    setInput("");
    setWaiting(true);
    try {
      // pi rejects a plain prompt while mid-turn — queue it as a steer instead.
      await client.prompt(id, {
        message: input,
        ...(status === "streaming" ? { streamingBehavior: "steer" as const } : {}),
      });
    } catch (err) {
      setWaiting(false);
      setError(String(err));
    }
  }, [client, input, activeId, openConversation, status]);

  // Aborts the in-flight turn. The gateway returns 202 immediately; the
  // session_state/idle envelope arrives shortly after and clears `waiting`
  // via applyEnvelope. We also reset `waiting` here so the UI does not
  // stall on "pi is thinking" between the click and the agent_settled event.
  const stop = useCallback(async () => {
    if (!client || !activeId) return;
    setStopping(true);
    setWaiting(false);
    try {
        await client.abort(activeId);
    } catch (err) {
        setError(String(err));
    } finally {
        setStopping(false);
    }
  }, [client, activeId]);

  const filteredConversations = useMemo(
    () => filterConversations(conversations, query),
    [conversations, query],
  );

  const startRename = useCallback((c: Conversation) => {
    setEditingId(c.id);
    setEditingTitle(c.title ?? "");
  }, []);

  const cancelRename = useCallback(() => {
    setEditingId(null);
    setEditingTitle("");
  }, []);

  const commitRename = useCallback(async (id: string) => {
    if (!client) return;
    const next = editingTitle.trim();
    if (!next) {
      cancelRename();
      return;
    }
    try {
      const updated = await client.renameConversation(id, { title: next });
      setConversations((prev) => prev.map((c) => (c.id === id ? updated : c)));
      cancelRename();
    } catch (err) {
      setError(String(err));
      cancelRename();
    }
  }, [client, editingTitle, cancelRename]);

  const askDelete = useCallback((id: string) => setPendingDeleteId(id), []);
  const cancelDelete = useCallback(() => setPendingDeleteId(null), []);

  const executeDelete = useCallback(async (id: string) => {
    if (!client) return;
    try {
      await client.deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeId === id) {
        closeStream.current?.();
        setActiveId(null);
        setMessages([]);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setPendingDeleteId(null);
    }
  }, [client, activeId]);

  const createNewConversation = useCallback(() => {
    closeStream.current?.();
    setActiveId(null);
    setMessages([]);
    setError(null);
    setWaiting(false);
  }, []);

  const statusLabel = useMemo(
    () => ({ idle: "idle", streaming: "working…", degraded: "degraded — will recover on next message" })[status],
    [status],
  );

  return (
    <main className="mx-auto flex h-screen max-w-3xl flex-col p-4">
      <header className="flex items-center justify-between pb-3">
        <h1 className="text-sm tracking-widest text-[#8b96a8]">AELVYRIL</h1>
        <div className="flex items-center gap-3 text-xs text-[#8b96a8]">
          <details className="relative">
            <summary className="cursor-pointer list-none rounded border border-[#2b3245] bg-[#161b27] px-2 py-1">
              {conversations.find((c) => c.id === activeId)?.title ?? "new conversation"}
            </summary>
            <div className="absolute right-0 top-full z-10 mt-1 w-80 rounded border border-[#2b3245] bg-[#0d1117] p-2 shadow-lg">
              <button
                className="mb-2 w-full rounded bg-[#1f6feb] px-2 py-1 text-left text-sm"
                onClick={(e) => {
                  e.preventDefault();
                  createNewConversation();
                  (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
                }}
                type="button"
              >
                + new conversation
              </button>
              <input
                aria-label="search conversations"
                className="mb-2 w-full rounded border border-[#2b3245] bg-[#161b27] px-2 py-1 text-sm outline-none focus:border-[#1f6feb]"
                data-testid="conv-search"
                onChange={(e) => setQuery(e.target.value)}
                placeholder="search…"
                type="text"
                value={query}
              />
              <ul className="max-h-60 overflow-y-auto">
                {filteredConversations.length === 0 && (
                  <li className="px-2 py-1 text-center text-[#8b96a8]">no matches</li>
                )}
                {filteredConversations.map((c) => (
                  <li
                    className="flex items-center justify-between rounded px-1 py-1 hover:bg-[#21262d]"
                    key={c.id}
                  >
                    {editingId === c.id ? (
                      <input
                        autoFocus
                        className="flex-1 rounded border border-[#2b3245] bg-[#161b27] px-1 py-0.5 text-sm outline-none focus:border-[#1f6feb]"
                        onBlur={() => void commitRename(c.id)}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename(c.id);
                          if (e.key === "Escape") cancelRename();
                        }}
                        type="text"
                        value={editingTitle}
                      />
                    ) : pendingDeleteId === c.id ? (
                      <>
                        <span className="flex-1 text-[#f85149]">delete this conversation?</span>
                        <button
                          className="ml-1 rounded border border-[#f85149]/40 bg-[#f85149]/10 px-1 text-xs text-[#f85149]"
                          onClick={(e) => {
                            e.preventDefault();
                            void executeDelete(c.id);
                          }}
                          type="button"
                        >
                          yes
                        </button>
                        <button
                          className="ml-1 rounded border border-[#2b3245] px-1 text-xs"
                          onClick={(e) => {
                            e.preventDefault();
                            cancelDelete();
                          }}
                          type="button"
                        >
                          no
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className={`flex-1 truncate text-left ${c.id === activeId ? "text-[#1f6feb]" : ""}`}
                          onClick={(e) => {
                            e.preventDefault();
                            openConversation(c.id);
                            (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
                          }}
                          type="button"
                        >
                          {c.title ?? c.id.slice(0, 12)}
                        </button>
                        <button
                          aria-label={`rename ${c.title ?? c.id}`}
                          className="ml-1 px-1 text-[#8b96a8] hover:text-[#e6edf3]"
                          onClick={(e) => {
                            e.preventDefault();
                            startRename(c);
                          }}
                          type="button"
                        >
                          ✎
                        </button>
                        <button
                          aria-label={`delete ${c.title ?? c.id}`}
                          className="ml-1 px-1 text-[#8b96a8] hover:text-[#f85149]"
                          onClick={(e) => {
                            e.preventDefault();
                            askDelete(c.id);
                          }}
                          type="button"
                        >
                          ×
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </details>
          <span data-testid="status">{statusLabel}</span>
          <span>hi, {user?.firstName ?? userId}</span>
          <UserButton />
        </div>
      </header>

      {error && (
        <div className="mb-2 rounded border border-[#f0883e]/40 bg-[#f0883e]/10 px-3 py-2 text-xs text-[#f0883e]">
          {error}
          <button className="ml-2 underline" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      {/* Spec §10: persistent banner while a backing service is degraded.
          Non-dismissable — the state IS the source of truth, hiding it
          would mislead the user. Disappears automatically when the next
          session_state envelope reports idle/streaming. */}
      {status === "degraded" && (
        <div
          aria-live="polite"
          className="mb-2 flex items-center gap-2 rounded border border-[#e3b341]/40 bg-[#e3b341]/10 px-3 py-2 text-xs text-[#e3b341]"
          data-testid="degraded-banner"
          role="status"
        >
          <span aria-hidden="true">⚠</span>
          <span>
            backing service degraded — chat continues. Next prompt will
            respawn the session host automatically.
          </span>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto rounded-lg border border-[#2b3245] bg-[#161b27] p-4">
        {messages.map((m, i) => (
          <div
            key={i}
            className={
              m.role === "user"
                ? "ml-auto max-w-[80%] rounded-lg bg-[#1f6feb]/20 px-3 py-2 text-sm"
                : m.role === "tool"
                  ? "text-xs text-[#8b96a8]"
                  : m.role === "system"
                    ? "text-center text-xs text-[#e3b341]"
                    : "max-w-[80%] whitespace-pre-wrap rounded-lg bg-[#21262d] px-3 py-2 text-sm"
            }
          >
            {m.text}
          </div>
        ))}
        {(waiting || (status === "streaming" && messages[messages.length - 1]?.role !== "assistant")) && (
          <div className="flex items-center gap-2 px-3 py-1" aria-live="polite" data-testid="typing">
            <span className="text-xs text-[#8b96a8]">pi is thinking</span>
            <span className="flex gap-1">
              <i className="size-1.5 animate-bounce rounded-full bg-[#8b96a8] [animation-delay:-0.3s]" />
              <i className="size-1.5 animate-bounce rounded-full bg-[#8b96a8] [animation-delay:-0.15s]" />
              <i className="size-1.5 animate-bounce rounded-full bg-[#8b96a8]" />
            </span>
          </div>
        )}
        {messages.length === 0 && (
          <div className="grid h-full place-items-center text-sm text-[#8b96a8]">
            say something — pi is listening
          </div>
        )}
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          className="flex-1 rounded-lg border border-[#2b3245] bg-[#161b27] px-3 py-2 text-sm outline-none focus:border-[#1f6feb]"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={waiting ? "pi is thinking…" : status === "streaming" ? "steer the agent…" : "message the agent…"}
        />
        <button
          className="rounded-lg bg-[#1f6feb] px-4 py-2 text-sm font-medium disabled:opacity-40"
          disabled={!input.trim()}
          type="submit"
        >
          send
        </button>
        {(waiting || status === "streaming") && (
          <button
            aria-label="stop the agent"
            className="rounded-lg border border-[#f85149]/40 bg-[#f85149]/10 px-4 py-2 text-sm text-[#f85149] disabled:opacity-40"
            disabled={stopping}
            onClick={(e) => {
              e.preventDefault();
              void stop();
            }}
            type="button"
          >
            {stopping ? "stopping…" : "stop"}
          </button>
        )}
      </form>
    </main>
  );
}

function appendAssistant(prev: UiMessage[], delta: string): UiMessage[] {
  const last = prev[prev.length - 1];
  if (last && last.role === "assistant") {
    return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
  }
  return [...prev, { role: "assistant", text: delta }];
}
