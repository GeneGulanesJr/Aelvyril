import type { EventEnvelope } from "@aelvyril/shared";
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

  /** Persist first (event log is the source of truth), then fan out live. */
  publish(envelope: Omit<EventEnvelope, "seq"> & { seq?: number }): EventEnvelope {
    const stored = this.store.appendEvent(envelope);
    const full = stored as EventEnvelope;
    const set = this.listeners.get(envelope.conversationId);
    if (set) for (const fn of set) fn(full);
    return full;
  }

  replay(conversationId: string, sinceSeq: number): EventEnvelope[] {
    return this.store.getEventsSince(conversationId, sinceSeq) as EventEnvelope[];
  }
}
