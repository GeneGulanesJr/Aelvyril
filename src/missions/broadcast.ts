import type { SharedState } from './shared-state.js';
import type { BroadcastEntry } from './missions.types.js';

export class BroadcastManager {
  constructor(private sharedState: SharedState) {}

  publish(from: string, type: BroadcastEntry['type'], message: string): void {
    this.sharedState.appendBroadcast({
      timestamp: new Date().toISOString(),
      from,
      type,
      message,
    });
  }

  readSince(index: number): BroadcastEntry[] {
    return this.sharedState.readBroadcasts(index);
  }

  readAll(): BroadcastEntry[] {
    return this.sharedState.readBroadcasts();
  }
}
