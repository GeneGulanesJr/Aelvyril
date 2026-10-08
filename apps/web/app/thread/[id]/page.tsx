"use client";
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { Thread } from "@aelvyril/shared";
import { useAppAuth } from "../../../components/auth-gate.js";
import { GatewayClient } from "../../../lib/api.js";
import { useThread } from "../../../lib/use-thread.js";
import { ThreadSidebar } from "../../../components/thread/sidebar.js";
import { ThreadInput } from "../../../components/thread/input.js";
import { SpecSession } from "../../../components/thread/spec-session.js";
import { OutputTabs } from "../../../components/thread/output-tabs.js";
import { ThreadHeader } from "../../../components/thread/header.js";
import { Banners } from "../../../components/thread/banner.js";

function SignInPrompt() {
  return (
    <main className="grid min-h-screen place-items-center">
      <div className="text-center">
        <h1 className="mb-4 text-2xl tracking-widest">AELVYRIL</h1>
        <a href="/sign-in" className="inline-block rounded-lg bg-[#1f6feb] px-4 py-2 text-sm">sign in</a>
      </div>
    </main>
  );
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function ThreadPage() {
  const { getToken, userId } = useAppAuth();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [client, setClient] = useState<GatewayClient | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  // Page-level action failures (rename, new-thread create) — merged into the
  // error banner alongside useThread's stream/mutation errors.
  const [actionError, setActionError] = useState<string | null>(null);
  // Synchronous double-submit guard for the new-thread create flow (state
  // alone can't stop two clicks inside one render cycle).
  const creatingRef = useRef(false);
  const [creating, setCreating] = useState(false);

  const signedIn = Boolean(userId);

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    (async () => {
      const c = new GatewayClient(
        (process.env.NEXT_PUBLIC_GATEWAY_URL as string | undefined) ?? "http://localhost:8787",
        getToken,
      );
      if (!cancelled) {
        setClient(c);
        try {
          setThreads(await c.listThreads());
        } catch (err) {
          // Same user-facing slot as every other action failure.
          if (!cancelled) setActionError(toErrorMessage(err));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [signedIn, getToken]);

  const isNew = id === "new";
  const threadState = useThread(isNew ? null : id, {
    getToken,
    // #83 sidebar: live spec_status envelopes update the ACTIVE entry of the
    // list so its pill matches the header's live pill between refetches.
    onStatus: (status) => setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, status } : t))),
  });

  if (!signedIn) return <SignInPrompt />;
  if (!client) return <div className="p-4 text-[#8b96a8]">loading…</div>;

  const activeThread = threads.find((t) => t.id === id);

  return (
    <div className="flex h-screen bg-[#010409] text-[#e6edf3]">
      <ThreadSidebar
        threads={threads}
        activeId={isNew ? null : id}
        onSelect={(tid) => router.push(`/thread/${tid}`)}
        onCreate={() => router.push("/thread/new")}
        onKillAll={async () => {
          // #84 kill-all: the server's response is the truth — refetch the
          // list instead of duplicating its live-state predicate here (the
          // optimistic flip drifted and sidebar pills never reconciled).
          try {
            await client.killAllThreads();
            setThreads(await client.listThreads());
          } catch (err) {
            setActionError(toErrorMessage(err));
          }
        }}
      />
      <main className="flex flex-1 flex-col overflow-hidden">
        <Banners
          degraded={threadState.degraded}
          blocked={threadState.blocked}
          error={threadState.error ?? actionError}
          onDismissError={() => {
            threadState.dismissError();
            setActionError(null);
          }}
        />
        {activeThread && (
          // key={activeThread.id}: rename draft + delete-armed state must not
          // survive a thread switch (a stray click could hit the wrong thread).
          <ThreadHeader
            key={activeThread.id}
            thread={activeThread}
            liveStatus={threadState.statusLive ? threadState.status : null}
            usage={threadState.usage ?? activeThread.usage}
            onRename={(title) =>
              void client
                .renameConversation(activeThread.id, { title })
                .then(() =>
                  setThreads((ts) => ts.map((t) => (t.id === activeThread.id ? { ...t, title } : t))),
                )
                .catch((err) => setActionError(toErrorMessage(err)))
            }
            onAbandon={() => void threadState.abandon()}
            onMerge={() => void threadState.merge()}
            onDelete={() =>
              void client
                .deleteThread(activeThread.id)
                .then(() => setThreads((ts) => ts.filter((t) => t.id !== activeThread.id)))
                .then(() => router.push("/thread/new"))
                .catch((err) => setActionError(toErrorMessage(err)))
            }
          />
        )}
        {!isNew && (
          <>
            <OutputTabs plan={threadState.plan} trace={threadState.trace} diff={threadState.diff} />
            {/* key={id}: answers typed for one thread must not leak into the next. */}
            <SpecSession
              key={id}
              questions={threadState.questions}
              draft={threadState.draft}
              status={threadState.status}
              // #81: a gated stop parks execution — the approve control must
              // stay reachable outside the spec'ing status.
              forceVisible={threadState.blocked === "gated"}
              onSubmitAnswers={(a) => void threadState.submitAnswers(a)}
              onEditSpec={(f, v) => void threadState.editSpec(f, v)}
              onApprove={() => void threadState.approve()}
              onCancel={() => router.push("/thread/new")}
            />
            {/* key={id}: a typed prompt must not survive a thread switch
                (same anti-leak as SpecSession above). */}
            <ThreadInput
              key={id}
              onAsk={(prompt, mode) => threadState.ask(prompt, mode)}
              disabled={false}
              waiting={threadState.waiting}
              onStop={() => void threadState.stop()}
            />
          </>
        )}
        {isNew && (
          <div className="flex flex-1 items-center justify-center">
            <ThreadInput
              onAsk={async (prompt, mode) => {
                if (creatingRef.current) return;
                creatingRef.current = true;
                setCreating(true);
                try {
                  const t = await client.createThread();
                  // Upsert before routing so the sidebar list (and the
                  // header actions it drives) contains the new thread even
                  // if the first prompt is still in flight.
                  setThreads((ts) => (ts.some((x) => x.id === t.id) ? ts : [t, ...ts]));
                  await client.prompt(t.id, { message: prompt, specMode: mode });
                  router.push(`/thread/${t.id}`);
                } catch (err) {
                  setActionError(toErrorMessage(err));
                  // Rethrow so ThreadInput knows the send failed and keeps
                  // the message (its .catch swallows this rethrow).
                  throw err;
                } finally {
                  creatingRef.current = false;
                  setCreating(false);
                }
              }}
              disabled={false}
              submitting={creating}
            />
          </div>
        )}
      </main>
    </div>
  );
}
