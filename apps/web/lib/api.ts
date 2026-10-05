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
        "content-type": "application/json",
      },
    };
  }

  async listConversations(): Promise<Conversation[]> {
    const res = await fetch(`${this.baseUrl}${ROUTES.conversations}`, await this.authed());
    if (!res.ok) throw new Error(`list failed: ${res.status}`);
    return ((await res.json()) as { conversations: Conversation[] }).conversations;
  }

  async createConversation(body: CreateConversationBody = {}): Promise<Conversation> {
    const res = await fetch(
      `${this.baseUrl}${ROUTES.conversations}`,
      await this.authed({ method: "POST", body: JSON.stringify(body) }),
    );
    if (!res.ok) throw new Error(`create failed: ${res.status}`);
    return (await res.json()) as Conversation;
  }

  async prompt(id: string, body: PromptBodyInput): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}${ROUTES.conversationPrompt(id)}`,
      await this.authed({ method: "POST", body: JSON.stringify(body) }),
    );
    if (!res.ok) throw new Error(`prompt failed: ${res.status}`);
  }

  async abort(id: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}${ROUTES.conversationAbort(id)}`,
      await this.authed({ method: "POST" }),
    );
    if (!res.ok) throw new Error(`abort failed: ${res.status}`);
  }

  async renameConversation(id: string, body: RenameConversationBody): Promise<Conversation> {
    const res = await fetch(
      `${this.baseUrl}${ROUTES.conversationRename(id)}`,
      await this.authed({ method: "PATCH", body: JSON.stringify(body) }),
    );
    if (!res.ok) throw new Error(`rename failed: ${res.status}`);
    return (await res.json()) as Conversation;
  }

  async deleteConversation(id: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}${ROUTES.conversationRename(id)}`,
      await this.authed({ method: "DELETE" }),
    );
    if (!res.ok) throw new Error(`delete failed: ${res.status}`);
  }

  // --- Threads (spec-centric UI surface) ---

  /** Create a thread. Server assigns id + draft status. */
  async createThread(body: CreateConversationBody = {}): Promise<Thread> {
    const res = await fetch(`${this.baseUrl}${ROUTES.threads}`, await this.authed({ method: "POST", body: JSON.stringify(body) }));
    if (!res.ok) throw new Error(`create thread failed: ${res.status}`);
    return (await res.json()) as Thread;
  }

  /** List threads. Wire key stays `conversations` (historical); items are threads. */
  async listThreads(): Promise<Thread[]> {
    const res = await fetch(`${this.baseUrl}${ROUTES.threads}`, await this.authed());
    if (!res.ok) throw new Error(`list threads failed: ${res.status}`);
    return ((await res.json()) as { conversations: Thread[] }).conversations;
  }

  /** Submit interview answers or edit a draft field. */
  async patchSpec(threadId: string, body: PatchSpecBody): Promise<void> {
    const res = await fetch(`${this.baseUrl}${ROUTES.threadSpec(threadId)}`, await this.authed({ method: "PATCH", body: JSON.stringify(body) }));
    if (!res.ok) throw new Error(`patch spec failed: ${res.status}`);
  }

  async approveSpec(threadId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${ROUTES.threadApprove(threadId)}`, await this.authed({ method: "POST" }));
    if (!res.ok) throw new Error(`approve failed: ${res.status}`);
  }

  async abandonThread(threadId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${ROUTES.threadAbandon(threadId)}`, await this.authed({ method: "POST" }));
    if (!res.ok) throw new Error(`abandon failed: ${res.status}`);
  }

  /** #84: global kill switch — abandon every live thread for the user. */
  async killAllThreads(): Promise<{ abandoned: number }> {
    const res = await fetch(`${this.baseUrl}${ROUTES.threadKillAll}`, await this.authed({ method: "POST" }));
    if (!res.ok) throw new Error(`kill-all failed: ${res.status}`);
    return (await res.json()) as { abandoned: number };
  }

  async retryThread(threadId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${ROUTES.threadRetry(threadId)}`, await this.authed({ method: "POST" }));
    if (!res.ok) throw new Error(`retry failed: ${res.status}`);
  }

  /** Cancel the in-flight turn (steer queue keeps the thread usable). */
  async abortThread(threadId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${ROUTES.threadAbort(threadId)}`, await this.authed({ method: "POST" }));
    if (!res.ok) throw new Error(`abort failed: ${res.status}`);
  }

  /** Delete the thread and its event history (cascades gateway-side). */
  async deleteThread(threadId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${ROUTES.thread(threadId)}`, await this.authed({ method: "DELETE" }));
    if (!res.ok) throw new Error(`delete failed: ${res.status}`);
  }

  async getUpdateStatus(): Promise<UpdateStatus> {
    const res = await fetch(`${this.baseUrl}/v1/admin/update/status`, await this.authed());
    if (!res.ok) throw new Error(`update status failed: ${res.status}`);
    return (await res.json()) as UpdateStatus;
  }

  async applyUpdate(): Promise<{ started: boolean; message: string }> {
    const res = await fetch(
      `${this.baseUrl}/v1/admin/update`,
      await this.authed({ method: "POST" }),
    );
    if (!res.ok) throw new Error(`update apply failed: ${res.status}`);
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
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
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
