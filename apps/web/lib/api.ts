import type {
  Conversation,
  CreateConversationBody,
  PromptBodyInput,
  RenameConversationBody,
  EventEnvelope,
  UpdateStatus,
  Thread,
  PatchSpecBody,
} from "@aelvyril/shared";
import { ROUTES } from "@aelvyril/shared";
import { SseParser } from "./sse.js";

type GetToken = () => Promise<string | null>;

/**
 * Non-2xx → Error. The gateway returns actionable JSON bodies
 * ({error:"agent_rejected"}, {error:"cost_cap_reached",cost,cap},
 * already_queued, 413 spec_too_large) — surface error/message/cost/cap in
 * the thrown Error instead of a bare status, falling back to a status-only
 * message when the body isn't JSON (proxy HTML, empty body, ...).
 */
async function apiError(label: string, res: Response): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as {
      error?: unknown;
      message?: unknown;
      cost?: unknown;
      cap?: unknown;
    };
    if (typeof body?.error === "string") {
      detail = body.error;
      const parts: string[] = [];
      if (typeof body.message === "string") parts.push(body.message);
      if (typeof body.cost === "number" && typeof body.cap === "number") {
        parts.push(`cost ${body.cost} > cap ${body.cap}`);
      }
      if (parts.length > 0) detail += ` (${parts.join("; ")})`;
    }
  } catch {
    // Body wasn't JSON — keep the status-only message below.
  }
  return new Error(detail ? `${label} failed: ${res.status} ${detail}` : `${label} failed: ${res.status}`);
}

export class GatewayClient {
  constructor(
    private baseUrl: string,
    private getToken: GetToken,
  ) {}

  private async authed(init: RequestInit = {}): Promise<RequestInit> {
    const token = await this.getToken();
    if (!token) throw new Error("not signed in");
    return {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${token}`,
        // Fastify rejects a body-less POST with a json content-type
        // (FST_ERR_CTP_EMPTY_JSON_BODY, 400) — kill-all / abandon send no
        // body, so only attach the header when there is one.
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
    };
  }

  async prompt(id: string, body: PromptBodyInput): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}${ROUTES.conversationPrompt(id)}`,
      await this.authed({ method: "POST", body: JSON.stringify(body) }),
    );
    if (!res.ok) throw await apiError("prompt", res);
  }

  async renameConversation(id: string, body: RenameConversationBody): Promise<Conversation> {
    const res = await fetch(
      `${this.baseUrl}${ROUTES.conversationRename(id)}`,
      await this.authed({ method: "PATCH", body: JSON.stringify(body) }),
    );
    if (!res.ok) throw await apiError("rename", res);
    return (await res.json()) as Conversation;
  }

  // --- Threads (spec-centric UI surface) ---

  /** Create a thread. Server assigns id + draft status. */
  async createThread(body: CreateConversationBody = {}): Promise<Thread> {
    const res = await fetch(`${this.baseUrl}${ROUTES.threads}`, await this.authed({ method: "POST", body: JSON.stringify(body) }));
    if (!res.ok) throw await apiError("create thread", res);
    return (await res.json()) as Thread;
  }

  /** List threads. Wire key stays `conversations` (historical); items are threads. */
  async listThreads(): Promise<Thread[]> {
    const res = await fetch(`${this.baseUrl}${ROUTES.threads}`, await this.authed());
    if (!res.ok) throw await apiError("list threads", res);
    return ((await res.json()) as { conversations: Thread[] }).conversations;
  }

  /** Submit interview answers or edit a draft field. */
  async patchSpec(threadId: string, body: PatchSpecBody): Promise<void> {
    const res = await fetch(`${this.baseUrl}${ROUTES.threadSpec(threadId)}`, await this.authed({ method: "PATCH", body: JSON.stringify(body) }));
    if (!res.ok) throw await apiError("patch spec", res);
  }

  async approveSpec(threadId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${ROUTES.threadApprove(threadId)}`, await this.authed({ method: "POST" }));
    if (!res.ok) throw await apiError("approve", res);
  }

  async abandonThread(threadId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${ROUTES.threadAbandon(threadId)}`, await this.authed({ method: "POST" }));
    if (!res.ok) throw await apiError("abandon", res);
  }

  /** #84: global kill switch — abandon every live thread for the user. */
  async killAllThreads(): Promise<{ abandoned: number }> {
    const res = await fetch(`${this.baseUrl}${ROUTES.threadKillAll}`, await this.authed({ method: "POST" }));
    if (!res.ok) throw await apiError("kill-all", res);
    return (await res.json()) as { abandoned: number };
  }

  async retryThread(threadId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${ROUTES.threadRetry(threadId)}`, await this.authed({ method: "POST" }));
    if (!res.ok) throw await apiError("retry", res);
  }

  /** #80: accept the reviewed diff — reviewed → merged (terminal). */
  async mergeThread(threadId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${ROUTES.threadMerge(threadId)}`, await this.authed({ method: "POST" }));
    if (!res.ok) throw await apiError("merge", res);
  }

  /** Cancel the in-flight turn (steer queue keeps the thread usable). */
  async abortThread(threadId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${ROUTES.threadAbort(threadId)}`, await this.authed({ method: "POST" }));
    if (!res.ok) throw await apiError("abort", res);
  }

  /** Delete the thread and its event history (cascades gateway-side). */
  async deleteThread(threadId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${ROUTES.thread(threadId)}`, await this.authed({ method: "DELETE" }));
    if (!res.ok) throw await apiError("delete", res);
  }

  async getUpdateStatus(): Promise<UpdateStatus> {
    const res = await fetch(`${this.baseUrl}${ROUTES.adminUpdateStatus}`, await this.authed());
    if (!res.ok) throw await apiError("update status", res);
    return (await res.json()) as UpdateStatus;
  }

  async applyUpdate(): Promise<{ started: boolean; message: string }> {
    const res = await fetch(
      `${this.baseUrl}${ROUTES.adminUpdate}`,
      await this.authed({ method: "POST" }),
    );
    if (!res.ok) throw await apiError("update apply", res);
    return (await res.json()) as { started: boolean; message: string };
  }

  /**
   * Streaming fetch of the event channel (NOT EventSource — it cannot send
   * an Authorization header). Reconnects with Last-Event-ID and exponential
   * backoff until aborted.
   *
   * #85: failure is no longer a 1-second hot loop forever. A clean EOF (the
   * server paging the replay) reconnects immediately; errors back off
   * 1s→30s; a 404 or repeated auth/network failure is terminal and fires
   * onLost so the UI can say the stream is gone instead of silently
   * retrying.
   */
  openStream(
    id: string,
    onEnvelope: (env: EventEnvelope) => void,
    signal?: AbortSignal,
    onLost?: (reason: "not_found" | "gave_up") => void,
  ): () => void {
    const controller = new AbortController();
    // Bridge the caller's signal onto the inner controller. Guard against a
    // signal that is ALREADY aborted (a listener would never fire and the
    // stream would reconnect forever) and detach the bridge when the inner
    // controller aborts so close() doesn't leak the listener.
    const bridgeAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else {
        signal.addEventListener("abort", bridgeAbort, { once: true });
        controller.signal.addEventListener("abort", () => signal.removeEventListener("abort", bridgeAbort), {
          once: true,
        });
      }
    }
    const MAX_FAILURES = 8;
    const MAX_AUTH_FAILURES = 3;
    void (async () => {
      const parser = new SseParser();
      let failures = 0;
      let authFailures = 0;
      while (!controller.signal.aborted) {
      let paged = false;
      let gotBytes = false;
      try {
        const token = await this.getToken();
        if (!token) throw new Error("stream auth: no token");
        const res = await fetch(`${this.baseUrl}${ROUTES.threadEvents(id)}`, {
          headers: { authorization: `Bearer ${token}`, "last-event-id": String(parser.lastSeenSeq) },
          signal: controller.signal,
        });
        if (!res.ok) {
          if (res.status === 404) {
            onLost?.("not_found");
            return;
          }
          if (res.status === 401 || res.status === 403) {
            authFailures++;
            if (authFailures >= MAX_AUTH_FAILURES) {
              onLost?.("gave_up");
              return;
            }
            throw new Error(`stream auth failed: ${res.status}`);
          }
          throw new Error(`stream failed: ${res.status}`);
        }
        if (!res.body) throw new Error("stream failed: no body");
        failures = 0;
        authFailures = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            // Clean EOF: the server ended a full replay page. Fetch the
            // next page immediately — this is progress, not a failure.
            // A close with NO bytes at all is not a page boundary (a proxy
            // swallowing the connection looks identical) — treat it as a
            // failure so the backoff applies instead of a hot reconnect
            // loop (2nd review).
            paged = gotBytes;
            break;
          }
          gotBytes = true;
          for (const env of parser.push(decoder.decode(value, { stream: true }))) {
            onEnvelope(env);
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error("stream error, retrying", err);
      }
        if (controller.signal.aborted) return;
        if (paged) continue;
        failures++;
        if (failures >= MAX_FAILURES) {
          onLost?.("gave_up");
          return;
        }
        const delay = Math.min(30_000, 1000 * 2 ** (failures - 1)) + Math.random() * 250;
        await new Promise((r) => setTimeout(r, delay));
      }
    })();
    return () => controller.abort();
  }
}
