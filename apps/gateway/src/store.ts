import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Conversation } from "@aelvyril/shared";

interface ConvRow {
  id: string;
  title: string | null;
  workspace: string | null;
  namespace: string;
  state: string;
  created_at: string;
}

export interface NewEvent {
  conversationId: string;
  ts: string;
  kind: string;
  payload: unknown;
}

export type StoredEvent = NewEvent & { seq: number };

export class Store {
  private db: Database.Database;
  private appendTxn: (ev: NewEvent) => StoredEvent;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations(
        id TEXT PRIMARY KEY,
        title TEXT,
        workspace TEXT,
        namespace TEXT NOT NULL DEFAULT 'platform',
        state TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events(
        conversation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (conversation_id, seq)
      );
    `);
    // Lightweight migration for pre-namespace databases (Phase 1 files):
    // backfill every existing row into the shared platform namespace. Runs
    // BEFORE the namespace index below, which needs the column to exist.
    const cols = this.db.prepare("PRAGMA table_info(conversations)").all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === "namespace")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN namespace TEXT NOT NULL DEFAULT 'platform'");
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_conversations_namespace ON conversations(namespace)",
    );
    // Assigned in the constructor: field initializers run BEFORE the
    // constructor body, so this.db would be undefined in a field initializer.
    this.appendTxn = this.db.transaction((ev: NewEvent): StoredEvent => {
      const row = this.db
        .prepare(
          "SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM events WHERE conversation_id = ?",
        )
        .get(ev.conversationId) as { next: number };
      const seq = row.next;
      this.db
        .prepare(
          "INSERT INTO events(conversation_id, seq, ts, kind, payload) VALUES(?, ?, ?, ?, ?)",
        )
        .run(ev.conversationId, seq, ev.ts, ev.kind, JSON.stringify(ev.payload));
      return { ...ev, seq };
    });
  }

  createConversation(input: {
    title?: string;
    workspace?: string;
    namespace: string;
  }): Conversation {
    const id = `conv_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO conversations(id, title, workspace, namespace, state, created_at) VALUES(?, ?, ?, ?, 'idle', ?)",
      )
      .run(id, input.title ?? null, input.workspace ?? null, input.namespace, createdAt);
    // namespace is internal routing, not exposed on the public DTO.
    return { id, title: input.title ?? null, workspace: input.workspace ?? null, state: "idle", createdAt };
  }

  renameConversation(id: string, namespace: string, title: string): void {
    this.db
      .prepare("UPDATE conversations SET title = ? WHERE id = ? AND namespace = ?")
      .run(title, id, namespace);
  }

  getConversation(id: string, namespace: string): Conversation | null {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE id = ? AND namespace = ?")
      .get(id, namespace) as ConvRow | undefined;
    return row ? this.toConversation(row) : null;
  }

  /**
   * Internal lookup without a namespace check. Used by the supervisor to
   * recover the workspace cwd at spawn time without re-plumbing the
   * namespace through every layer. Never expose this on any /v1 route.
   */
  getConversationById(id: string): Conversation | null {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(id) as ConvRow | undefined;
    return row ? this.toConversation(row) : null;
  }

  listConversations(namespace: string): Conversation[] {
    const rows = this.db
      .prepare("SELECT * FROM conversations WHERE namespace = ? ORDER BY created_at DESC")
      .all(namespace) as ConvRow[];
    return rows.map((r) => this.toConversation(r));
  }

  setConversationState(id: string, state: string): void {
    this.db.prepare("UPDATE conversations SET state = ? WHERE id = ?").run(state, id);
  }

  appendEvent(ev: NewEvent): StoredEvent {
    return this.appendTxn(ev);
  }

  getEventsSince(conversationId: string, sinceSeq: number): StoredEvent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC",
      )
      .all(conversationId, sinceSeq) as Array<{
      conversation_id: string;
      seq: number;
      ts: string;
      kind: string;
      payload: string;
    }>;
    return rows.map((r) => ({
      conversationId: r.conversation_id,
      seq: r.seq,
      ts: r.ts,
      kind: r.kind,
      payload: JSON.parse(r.payload) as unknown,
    }));
  }

  close(): void {
    this.db.close();
  }

  private toConversation(r: ConvRow): Conversation {
    return {
      id: r.id,
      title: r.title,
      workspace: r.workspace,
      state: r.state as Conversation["state"],
      createdAt: r.created_at,
    };
  }
}
