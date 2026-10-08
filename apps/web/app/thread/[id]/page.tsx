"use client";
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Menu, Plus } from "lucide-react";
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
import { RouteLine } from "../../../components/thread/route-line.js";
import { ToastHost, useToast } from "../../../components/toasts.js";
import { UIProvider } from "../../../components/crew/ui-mode.js";

/** The brand mark: a three-aspect signal head. */
function SignalMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className="mx-auto h-10 w-10">
      <rect width="32" height="32" rx="7" className="fill-panel-raised" />
      <rect x="10" y="4" width="12" height="24" rx="6" className="fill-panel stroke-seam" />
      <circle cx="16" cy="10" r="2.6" className="fill-danger" />
      <circle cx="16" cy="16" r="2.6" className="fill-caution" />
      <circle cx="16" cy="22" r="2.6" className="fill-go" />
    </svg>
  );
}

function SignInPrompt() {
  return (
    <main className="grid min-h-screen place-items-center bg-desk">
      <div className="text-center">
        <SignalMark />
        <h1 className="mt-4 text-2xl font-semibold tracking-[0.3em] text-ink">AELVYRIL</h1>
        <p className="mt-1 text-sm text-ink-muted">Agent workspace — ask, watch the route, merge the diff.</p>
        <a
          href="/sign-in"
          className="mt-6 inline-block rounded-md bg-route px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-route/90"
        >
          sign in
        </a>
      </div>
    </main>
  );
}

/** Thread list + desk skeleton while the client and list load — never a bare
 *  "loading…" line; the board shape should be visible immediately. */
function LoadingDesk() {
  return (
    <div className="flex h-screen bg-desk text-ink" aria-label="Loading the desk">
      <div className="hidden w-[280px] shrink-0 flex-col gap-2 border-r border-seam p-3 md:flex">
        <div className="h-9 animate-pulse rounded-md bg-panel-raised" />
        <div className="h-8 animate-pulse rounded-md bg-panel-raised" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-11 animate-pulse rounded-md bg-panel-raised" />
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="h-8 w-72 animate-pulse rounded bg-panel-raised" />
        <div className="h-6 w-80 animate-pulse rounded bg-panel-raised" />
        <div className="min-h-0 flex-1 animate-pulse rounded bg-panel/60" />
        <div className="h-24 animate-pulse rounded-md bg-panel-raised" />
      </div>
    </div>
  );
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function Desk() {
  const { getToken, userId } = useAppAuth();
  const router = useRouter();
  const toast = useToast();
  const { id } = useParams<{ id: string }>();
  const [client, setClient] = useState<GatewayClient | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  // Page-level action failures (rename, new-thread create) — merged into the
  // status band alongside useThread's stream/mutation errors.
  const [actionError, setActionError] = useState<string | null>(null);
  // Synchronous double-submit guard for the new-thread create flow (state
  // alone can't stop two clicks inside one render cycle).
  const creatingRef = useRef(false);
  const [creating, setCreating] = useState(false);
  // Mobile: the board slides in as a drawer over the desk.
  const [navOpen, setNavOpen] = useState(false);
  // The blocked "question" band points at the spec interview.
  const specRef = useRef<HTMLDivElement>(null);

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
          if (!cancelled) setActionError(toErrorMessage(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn, getToken]);

  const isNew = id === "new";
  const threadState = useThread(isNew ? null : id, {
    getToken,
    // #83 sidebar: live spec_status envelopes update the ACTIVE entry of the
    // list so its lamp matches the header's live lamp between refetches.
    onStatus: (status) => setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, status } : t))),
  });

  if (!signedIn) return <SignInPrompt />;
  if (!client) return <LoadingDesk />;

  const activeThread = threads.find((t) => t.id === id);
  const boardStatus = threadState.statusLive ? threadState.status : (activeThread?.status ?? "draft");
  const gotoSpec = () => specRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  // Crew mode: dispatched subagents (real name + task from subagent_spawn).
  const crew = threadState.timeline
    .filter((t) => t.kind === "subagents")
    .flatMap((t) => t.agents.map((a) => ({ name: a.agent, task: a.task })));
  const seenCrew = new Set<string>();
  const crewUnits = crew.filter((u) => (seenCrew.has(u.name) ? false : (seenCrew.add(u.name), true)));
  // Work sparks encode "a tool is executing right now": the run is live and
  // the newest tool call on the timeline has not landed a result yet.
  const lastTool = [...threadState.timeline].reverse().find((t) => t.kind === "tool");
  const workPending = threadState.waiting && !!lastTool && !lastTool.result;

  const sidebar = (
    <ThreadSidebar
      threads={threads}
      activeId={isNew ? null : id}
      onSelect={(tid) => {
        setNavOpen(false);
        router.push(`/thread/${tid}`);
      }}
      onCreate={() => {
        setNavOpen(false);
        router.push("/thread/new");
      }}
      onKillAll={async () => {
        // #84 kill-all: the server's response is the truth — refetch the
        // list instead of duplicating its live-state predicate here (the
        // optimistic flip drifted and sidebar lamps never reconciled).
        try {
          await client.killAllThreads();
          setThreads(await client.listThreads());
          toast("All live threads abandoned");
        } catch (err) {
          setActionError(toErrorMessage(err));
        }
      }}
    />
  );

  return (
    <div className="flex h-screen bg-desk text-ink">
      <div className="hidden h-full md:block">{sidebar}</div>

      {navOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button aria-label="Close the board" onClick={() => setNavOpen(false)} className="absolute inset-0 bg-black/60" />
          <div className="absolute inset-y-0 left-0 shadow-drawer">{sidebar}</div>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-panel">
        {/* Mobile desk bar — the board is a drawer below md. */}
        <div className="flex items-center gap-1 border-b border-seam bg-desk px-2 py-1.5 md:hidden">
          <button
            aria-label="Open the thread board"
            data-testid="board-toggle"
            onClick={() => setNavOpen(true)}
            className="rounded-md p-2 text-ink-muted transition-colors hover:bg-panel-raised hover:text-ink"
          >
            <Menu className="size-4" aria-hidden />
          </button>
          <span className="min-w-0 flex-1 truncate text-sm text-ink">{activeThread?.title ?? "Aelvyril"}</span>
          <button
            aria-label="New thread"
            onClick={() => {
              setNavOpen(false);
              router.push("/thread/new");
            }}
            className="rounded-md p-2 text-ink-muted transition-colors hover:bg-panel-raised hover:text-ink"
          >
            <Plus className="size-4" aria-hidden />
          </button>
        </div>

        <Banners
          degraded={threadState.degraded}
          blocked={threadState.blocked}
          error={threadState.error ?? actionError}
          onDismissError={() => {
            threadState.dismissError();
            setActionError(null);
          }}
          onRetry={() => void threadState.retry()}
          onGotoSpec={gotoSpec}
          onApprove={() => void threadState.approve()}
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
                .then(() => {
                  setThreads((ts) => ts.map((t) => (t.id === activeThread.id ? { ...t, title } : t)));
                  toast("Thread renamed");
                })
                .catch((err) => setActionError(toErrorMessage(err)))
            }
            onAbandon={() => void threadState.abandon().then(() => toast("Thread abandoned"))}
            onMerge={() => void threadState.merge().then(() => toast("Diff merged"))}
            onDelete={() =>
              void client
                .deleteThread(activeThread.id)
                .then(() => setThreads((ts) => ts.filter((t) => t.id !== activeThread.id)))
                .then(() => {
                  toast("Thread deleted");
                  router.push("/thread/new");
                })
                .catch((err) => setActionError(toErrorMessage(err)))
            }
          />
        )}

        {!isNew && <RouteLine status={boardStatus} degraded={threadState.degraded} crew={crewUnits} workPending={workPending} />}

        {!isNew && (
          <>
            <OutputTabs
              plan={threadState.plan}
              draft={threadState.draft}
              trace={threadState.trace}
              timeline={threadState.timeline}
              diff={threadState.diff}
              streamLive={threadState.waiting}
            />
            {/* key={id}: answers typed for one thread must not leak into the next. */}
            <div ref={specRef}>
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
            </div>
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
          <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto p-6">
            <div className="w-full max-w-2xl">
              <div className="mb-8">
                <RouteLine status="draft" />
                <h1 className="mt-8 text-2xl font-medium tracking-tight text-ink">Set the work in motion.</h1>
                <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-muted">
                  Describe the work — the agent plans, runs, and hands back a diff to merge. Ambiguous
                  asks get a short interview first; force one any time with Ask + spec.
                </p>
              </div>
              <div className="overflow-hidden rounded-lg border border-seam bg-panel shadow-pop">
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
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default function ThreadPage() {
  return (
    <ToastHost>
      <UIProvider>
        <Desk />
      </UIProvider>
    </ToastHost>
  );
}
