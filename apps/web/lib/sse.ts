import { EventEnvelope, type EventEnvelope as EventEnvelopeType } from "@aelvyril/shared";

/**
 * Incremental parser for the gateway's SSE grammar:
 * blocks of `id:/event:/data:` separated by blank lines, `retry:` and
 * `: ping` comment lines interleaved. Enforces seq monotonicity so a
 * reconnect replay can never double-apply, and validates every envelope
 * against the shared zod union (security review #85): malformed JSON or a
 * bad kind is skipped instead of thrown, so one bad block can't kill the
 * stream or escape validation on the client side.
 */
export class SseParser {
  private buffer = "";
  private lastSeq = -1;

  push(chunk: string): EventEnvelopeType[] {
    this.buffer += chunk;
    const out: EventEnvelopeType[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue; // retry:/comment blocks
      let raw: unknown;
      try {
        raw = JSON.parse(dataLine.slice(6));
      } catch {
        continue; // malformed block — skip, keep the stream alive
      }
      const parsed = EventEnvelope.safeParse(raw);
      if (!parsed.success) continue;
      const env = parsed.data;
      if (env.seq <= this.lastSeq) continue;
      this.lastSeq = env.seq;
      out.push(env);
    }
    return out;
  }

  get lastSeenSeq(): number {
    return this.lastSeq;
  }
}
