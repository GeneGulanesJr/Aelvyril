"use client";
import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useParams, useRouter } from "next/navigation";
import type { Thread } from "@aelvyril/shared";
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

export default function ThreadPage() {
  const { getToken, userId } = useAuth();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [client, setClient] = useState<GatewayClient | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);

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
          console.error("listThreads failed", err);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [signedIn, getToken]);

  const isNew = id === "new";
  const threadState = useThread(isNew ? null : id, { getToken });

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
      />
      <main className="flex flex-1 flex-col overflow-hidden">
        <Banners degraded={threadState.degraded} error={threadState.error} onDismissError={threadState.dismissError} />
        {activeThread && (
          <ThreadHeader
            thread={activeThread}
            onRename={(title) => void client.renameConversation(activeThread.id, { title }).then(() => {
              setThreads((ts) => ts.map((t) => (t.id === activeThread.id ? { ...t, title } : t)));
            })}
            onAbandon={() => void threadState.abandon()}
            onDelete={() =>
              void client
                .deleteThread(activeThread.id)
                .then(() => setThreads((ts) => ts.filter((t) => t.id !== activeThread.id)))
                .then(() => router.push("/thread/new"))
                .catch((err) => console.error("delete failed", err))
            }
          />
        )}
        {!isNew && (
          <>
            <OutputTabs plan={threadState.plan} trace={threadState.trace} diff={threadState.diff} />
            <SpecSession
              questions={threadState.questions}
              draft={threadState.draft}
              status={threadState.status}
              onSubmitAnswers={(a) => void threadState.submitAnswers(a)}
              onEditSpec={(f, v) => void threadState.editSpec(f, v)}
              onApprove={() => void threadState.approve()}
              onCancel={() => router.push("/thread/new")}
            />
            <ThreadInput
              onAsk={(prompt, mode) => void threadState.ask(prompt, mode)}
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
                const t = await client.createThread();
                await client.prompt(t.id, { message: prompt, specMode: mode });
                router.push(`/thread/${t.id}`);
              }}
              disabled={false}
            />
          </div>
        )}
      </main>
    </div>
  );
}
