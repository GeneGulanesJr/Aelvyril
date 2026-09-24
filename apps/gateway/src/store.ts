import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Conversation, SpecDraft } from "@aelvyril/shared";

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

/**
 * Idempotent schema migrations: table creation + column backfills.
 * Safe to run repeatedly (CREATE IF NOT EXISTS + column presence checks);
 * also callable standalone (tests, admin tooling).
 */
export function runMigrations(db: Database.Database): void {
  db.exec(`
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
  // BEFORE the namespace index in the constructor, which needs the column.
  const cols = db.prepare("PRAGMA table_info(conversations)").all() as Array<{
    name: string;
  }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("namespace")) {
    db.exec("ALTER TABLE conversations ADD COLUMN namespace TEXT NOT NULL DEFAULT 'platform'");
  }
  // Thread lifecycle + spec-interview blobs (agent spec-centric UI, Slice 1).
  if (!names.has("status")) {
    db.exec("ALTER TABLE conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'");
  }
  if (!names.has("spec_draft")) {
    db.exec("ALTER TABLE conversations ADD COLUMN spec_draft TEXT");
  }
  if (!names.has("spec_questions")) {
    db.exec("ALTER TABLE conversations ADD COLUMN spec_questions TEXT");
  }
  if (!names.has("spec_answers")) {
    db.exec("ALTER TABLE conversations ADD COLUMN spec_answers TEXT");
  }
}

export class Store {
  private db: Database.Database;
  private appendTxn: (ev: NewEvent) => StoredEvent;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    runMigrations(this.db);
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

  /** Spec-interview state for a thread, or null if the id/namespace pair has no row. */
  getThreadSpec(id: string, namespace: string): {
    status: string;
    specDraft: SpecDraft | null;
    specAnswers: Record<string, string>;
  } | null {
    const row = this.db
      .prepare("SELECT status, spec_draft, spec_answers FROM conversations WHERE id = ? AND namespace = ?")
      .get(id, namespace) as
      | { status: string; spec_draft: string | null; spec_answers: string | null }
      | undefined;
    if (!row) return null;
    return {
      status: row.status,
      specDraft: row.spec_draft ? (JSON.parse(row.spec_draft) as SpecDraft) : null,
      specAnswers: row.spec_answers ? (JSON.parse(row.spec_answers) as Record<string, string>) : {},
    };
  }

  /** Merge answers into the spec_answers blob. Returns false if the thread
   *  doesn't exist under this namespace (cross-tenant writes are no-ops). */
  mergeSpecAnswers(id: string, namespace: string, answers: Record<string, string>): boolean {
    const spec = this.getThreadSpec(id, namespace);
    if (!spec) return false;
    const merged = { ...spec.specAnswers, ...answers };
    this.db
      .prepare("UPDATE conversations SET spec_answers = ? WHERE id = ? AND namespace = ?")
      .run(JSON.stringify(merged), id, namespace);
    return true;
  }

  /** Patch one SpecDraft field, auto-initializing an empty draft on first
   *  edit (the UI may let the user draft before the agent emits one).
   *  Returns false if the thread doesn't exist under this namespace. */
  patchSpecDraft(
    id: string,
    namespace: string,
    field: "goal" | "filesAffected" | "plan" | "risks",
    value: string | string[],
  ): boolean {
    const spec = this.getThreadSpec(id, namespace);
    if (!spec) return false;
    const draft: SpecDraft = spec.specDraft ?? {
      goal: "",
      filesAffected: [],
      plan: [],
      risks: [],
      questions: [],
      answers: {},
    };
    const patched = { ...draft, [field]: value };
    this.db
      .prepare("UPDATE conversations SET spec_draft = ? WHERE id = ? AND namespace = ?")
      .run(JSON.stringify(patched), id, namespace);
    return true;
  }

  /** Returns true if a conversation row was actually deleted. */
  deleteConversation(id: string, namespace: string): boolean {
    // Cascade events so a deleted conversation leaves no orphan history. The
    // seq counter is per-conversation so there's no global state to reset.
    const txn = this.db.transaction(() => {
      this.db.prepare("DELETE FROM events WHERE conversation_id = ?").run(id);
      const info = this.db
        .prepare("DELETE FROM conversations WHERE id = ? AND namespace = ?")
        .run(id, namespace);
      return info.changes > 0;
    });
    return txn();
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

  /** Spec §10: total conversations for a namespace — used for the cap check. */
  countConversations(namespace: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM conversations WHERE namespace = ?")
      .get(namespace) as { n: number };
    return row.n;
  }

  /** Spec §10: conversations currently streaming for a namespace. */
  countStreaming(namespace: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM conversations WHERE namespace = ? AND state = 'streaming'")
      .get(namespace) as { n: number };
    return row.n;
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
