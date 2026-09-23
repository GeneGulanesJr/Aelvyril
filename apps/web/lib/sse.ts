import type { EventEnvelope } from "@aelvyril/shared";

/**
 * Incremental parser for the gateway's SSE grammar:
 * blocks of `id:/event:/data:` separated by blank lines, `retry:` and
 * `: ping` comment lines interleaved. Enforces seq monotonicity so a
 * reconnect replay can never double-apply.
 */
export class SseParser {
  private buffer = "";
  private lastSeq = -1;

  push(chunk: string): EventEnvelope[] {
    this.buffer += chunk;
    const out: EventEnvelope[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue; // retry:/comment blocks
      const env = JSON.parse(dataLine.slice(6)) as EventEnvelope;
      if (typeof env.seq !== "number" || env.seq <= this.lastSeq) continue;
      this.lastSeq = env.seq;
      out.push(env);
    }
    return out;
  }

  get lastSeenSeq(): number {
    return this.lastSeq;
  }
}
