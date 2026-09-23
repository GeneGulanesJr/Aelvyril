"use client";

import { UserButton, useAuth, useUser } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation, EventEnvelope } from "@aelvyril/shared";
import { GatewayClient } from "../lib/api";

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
  const closeStream = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!getToken) return;
    setClient(new GatewayClient(process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787", getToken));
  }, [getToken]);

  const applyEnvelope = useCallback((env: EventEnvelope) => {
    setMessages((prev) => {
      switch (env.kind) {
        case "text_delta":
          return appendAssistant(prev, env.payload.delta);
        case "tool_call":
          return [...prev, { role: "tool", text: `⚙ ${env.payload.toolName}` }];
        case "tool_result":
          return prev;
        case "session_state":
          setStatus(env.payload.state === "streaming" ? "streaming" : env.payload.state === "degraded" ? "degraded" : "idle");
          return env.payload.state === "restarted"
            ? [...prev, { role: "system", text: "agent restarted — context restored" }]
            : prev;
        case "error":
          setError(env.payload.message);
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

  const send = useCallback(async () => {
    if (!client || !input.trim()) return;
    let id = activeId;
    if (!id) {
      const conv = await client.createConversation({});
      id = conv.id;
      setActiveId(id);
      openConversation(id);
    }
    setMessages((prev) => [...prev, { role: "user", text: input }]);
    setInput("");
    try {
      await client.prompt(id, { message: input });
    } catch (err) {
      setError(String(err));
    }
  }, [client, input, activeId, openConversation]);

  const statusLabel = useMemo(
    () => ({ idle: "idle", streaming: "working…", degraded: "degraded — will recover on next message" })[status],
    [status],
  );

  return (
    <main className="mx-auto flex h-screen max-w-3xl flex-col p-4">
      <header className="flex items-center justify-between pb-3">
        <h1 className="text-sm tracking-widest text-[#8b96a8]">AELVYRIL</h1>
        <div className="flex items-center gap-3 text-xs text-[#8b96a8]">
          <select
            className="rounded border border-[#2b3245] bg-[#161b27] px-2 py-1"
            value={activeId ?? ""}
            onChange={(e) => e.target.value && openConversation(e.target.value)}
          >
            <option value="">new conversation</option>
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title ?? c.id.slice(0, 12)}
              </option>
            ))}
          </select>
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

      <div className="flex-1 space-y-2 overflow-y-auto rounded-lg border border-[#2b3245] bg-[#161b27] p-4">
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
          placeholder="message the agent…"
        />
        <button
          className="rounded-lg bg-[#1f6feb] px-4 py-2 text-sm font-medium disabled:opacity-40"
          disabled={!input.trim()}
          type="submit"
        >
          send
        </button>
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
