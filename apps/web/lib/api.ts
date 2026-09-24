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
   * an Authorization header). Reconnects with Last-Event-ID until aborted.
   */
  openStream(
    id: string,
    onEnvelope: (env: EventEnvelope) => void,
    signal?: AbortSignal,
  ): () => void {
    const controller = new AbortController();
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
    void (async () => {
      const parser = new SseParser();
      while (!controller.signal.aborted) {
        try {
          const res = await fetch(`${this.baseUrl}${ROUTES.conversationEvents(id)}`, {
            headers: { authorization: `Bearer ${await this.getToken()}`, "last-event-id": String(parser.lastSeenSeq) },
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const env of parser.push(decoder.decode(value, { stream: true }))) {
              onEnvelope(env);
            }
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          console.error("stream error, retrying", err);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    })();
    return () => controller.abort();
  }
}
