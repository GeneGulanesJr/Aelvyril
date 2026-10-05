# Long-horizon execution: cap running hosts, not threads; durable prompt queue

The original abuse caps (spec §10) limited conversations to 3 per user and
prompts to 20/min. Both numbers were chat-shaped. Threads are cheap SQLite
rows; the scarce resource is a **running session host** (a `pi --mode rpc`
child process, ADR-0001). Execution was also tied to a live SSE viewer: a
turn only made progress while a browser tab was open, idle hosts were
reaped after 5 minutes regardless of pending work, and there was no way to
"fire off five tasks and walk away."

**Decision (issue #83):**

- **Thread count is not the limit.** `maxConversationsPerUser` default
  3 → **30** (`GATEWAY_MAX_THREADS`). Deleting old threads to free slots
  was a chore, not a decision.
- **Running hosts are the limit.** New per-user cap
  (`GATEWAY_MAX_RUNNING_HOSTS`, default **2**) enforced at prompt time via
  `store.countStreaming`, plus a global host ceiling
  (`GATEWAY_MAX_SESSION_HOSTS`, default **100**) via
  `Supervisor.runningCount()`.
- **Beyond the cap, prompts queue — they don't fail.** A prompt that
  arrives when the user is at their host cap is written to the durable
  `prompt_queue` table (same SQLite file as everything else), the thread
  status becomes `queued`, and the route returns
  `202 {accepted: true, queued: true}`. A duplicate non-steer prompt on a
  queued thread is `409 already_queued`. Steers pass through untouched —
  they target a live run by definition.
- **A background runner decouples execution from the viewer.** Every
  `GATEWAY_QUEUE_INTERVAL_MS` (default 2s) it drains the queue FIFO per
  namespace, fairly across namespaces, only while the user has a free host
  slot. Spawning is on-demand (`Supervisor.ensureSession`), so a queued
  prompt executes with nobody watching. `Last-Event-ID` replay means the
  returning viewer gets the full progress summary for free.
- **Restart safety.** On boot the store marks rows still `state='streaming'`
  as `degraded` (their hosts died with the old process); queued prompts are
  durable rows and are picked up by the next process's runner. Idle
  reaping stays inactivity-based (`lastActivity` tracks protocol events) —
  a host doing work is never reaped just because no one is watching.

**Why a SQLite table and not an in-process array:** the queue must survive
the exact event it protects against — a gateway restart/deploy. It shares
WAL with the rest of the store, and the runner's dequeue is a transactional
read+delete, so two ticks can't double-start a prompt.

**Why fairness across namespaces:** `listQueuedNamespaces()` orders by the
oldest queued item per namespace, and the runner takes one namespace per
pass — a user who enqueued 20 tasks can't starve another user's single
queued prompt.

**Considered alternatives (rejected):**
- *Reject prompts over the cap (503)* — the v1 behavior, and exactly the
  friction this ADR removes. Chat-shaped.
- *Spawn a host per queued prompt immediately* — that is the resource the
  cap exists to protect.
- *Redis / external queue* — same argument as ADR-0004: v1 is one node,
  one writer, and the queue shares fate with the gateway anyway.

**Consequences:**
- `GATEWAY_MAX_RUNNING_HOSTS` is the number that costs money; raise it
  deliberately.
- A queued thread blocks further non-steer prompts to itself (409) until
  the runner starts the turn — the UI shows the `queued` pill.
- `kill-all` (issue #84) drops queued work for the calling user, so the
  global kill switch is also the queue drain.
- The runner is in-process (like the rate limiter). Horizontal scale-out
  needs the queue claim to move to the shared DB with a lease — noted in
  the ops runbook's scaling section.

Status: accepted 2026-10-05 (issues #83, #84; supersedes the spec §10
"3 conversations/user" default; companion to ADR-0001 — hosts stay child
processes).
