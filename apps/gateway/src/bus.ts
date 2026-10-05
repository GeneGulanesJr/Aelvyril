import type { EventEnvelope } from "@aelvyril/shared";
import { EventEnvelope as EventEnvelopeSchema } from "@aelvyril/shared";
import type { Store } from "./store.js";

type Listener = (envelope: EventEnvelope) => void;

export class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  constructor(private store: Store) {}

  subscribe(conversationId: string, fn: Listener): () => void {
    let set = this.listeners.get(conversationId);
    if (!set) {
      set = new Set();
      this.listeners.set(conversationId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(conversationId);
    };
  }

  /**
   * Persist first (event log is the source of truth), then fan out live.
   * Security review #85: the envelope is validated against the zod union at
   * the wire boundary — an invalid envelope is neither stored nor fanned
   * out, so malformed kinds can never desync SSE framing downstream.
   * Returns null when the envelope was rejected.
   */
  publish(envelope: Omit<EventEnvelope, "seq"> & { seq?: number }): EventEnvelope | null {
    // seq is assigned by the store, so it is excluded from the probe: the
    // placeholder only lets the full union shape validate up front.
    const probe = EventEnvelopeSchema.safeParse({ ...envelope, seq: 0 });
    if (!probe.success) return null;
    const stored = this.store.appendEvent(envelope);
    const full = stored as EventEnvelope;
    const set = this.listeners.get(envelope.conversationId);
    if (set) for (const fn of set) fn(full);
    return full;
  }

  replay(conversationId: string, sinceSeq: number, limit?: number): EventEnvelope[] {
    return this.store.getEventsSince(conversationId, sinceSeq, limit) as EventEnvelope[];
  }
}
