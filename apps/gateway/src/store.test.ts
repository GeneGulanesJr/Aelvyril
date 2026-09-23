import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations, Store } from "./store.js";

const ts = "2026-09-22T12:00:00.000Z";
const PLATFORM = "platform";

describe("Store", () => {
  it("creates and lists conversations", () => {
    const store = new Store(":memory:");
    const conv = store.createConversation({ title: "t", workspace: "LaPis", namespace: PLATFORM });
    expect(conv.id).toMatch(/^conv_/);
    expect(conv.state).toBe("idle");
    const list = store.listConversations(PLATFORM);
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("t");
  });

  it("gets a conversation or null", () => {
    const store = new Store(":memory:");
    const conv = store.createConversation({ namespace: PLATFORM });
    expect(store.getConversation(conv.id, PLATFORM)?.id).toBe(conv.id);
    expect(store.getConversation("conv_nope", PLATFORM)).toBeNull();
  });

  it("scopes conversations by namespace", () => {
    const store = new Store(":memory:");
    const a = store.createConversation({ title: "a", namespace: "user:user_a" });
    store.createConversation({ title: "b", namespace: "user:user_b" });
    const forA = store.listConversations("user:user_a");
    expect(forA).toHaveLength(1);
    expect(forA[0]!.id).toBe(a.id);
    expect(store.listConversations("user:user_b")).toHaveLength(1);
    expect(store.listConversations("user:nobody")).toHaveLength(0);
    // cross-namespace reads are invisible, even by id
    expect(store.getConversation(a.id, "user:user_b")).toBeNull();
    expect(store.getConversation(a.id, "user:user_a")?.title).toBe("a");
  });

  it("migrates a pre-namespace database", () => {
    const dbPath = join(tmpdir(), `aelvyril-store-test-${randomUUID()}.db`);
    // Simulate a Phase 1 database (no namespace column) with one row.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE IF NOT EXISTS conversations(
        id TEXT PRIMARY KEY,
        title TEXT,
        workspace TEXT,
        state TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL
      );
      INSERT INTO conversations(id, title, workspace, state, created_at)
        VALUES('conv_legacy', 'old', NULL, 'idle', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    try {
      const store = new Store(dbPath);
      // Legacy row is readable and lands in the platform namespace.
      expect(store.getConversation("conv_legacy", "platform")?.title).toBe("old");
      expect(store.getConversation("conv_legacy", "user:x")).toBeNull();
      // New writes work.
      const conv = store.createConversation({ namespace: "user:x" });
      expect(store.listConversations("user:x")).toHaveLength(1);
      expect(conv.id).toMatch(/^conv_/);
      store.close();
    } finally {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // best-effort cleanup; Windows can briefly hold the handle after close
      }
    }
  });

  it("appends events with per-conversation monotonic seq", () => {
    const store = new Store(":memory:");
    const a = store.createConversation({ namespace: PLATFORM });
    const b = store.createConversation({ namespace: PLATFORM });
    const e1 = store.appendEvent({ conversationId: a.id, ts, kind: "text_delta", payload: { delta: "x" } });
    const e2 = store.appendEvent({ conversationId: a.id, ts, kind: "text_delta", payload: { delta: "y" } });
    const e3 = store.appendEvent({ conversationId: b.id, ts, kind: "session_state", payload: { state: "streaming" } });
    expect(e1.seq).toBe(0);
    expect(e2.seq).toBe(1);
    expect(e3.seq).toBe(0);
  });

  it("replays events since a seq", () => {
    const store = new Store(":memory:");
    const conv = store.createConversation({ namespace: PLATFORM });
    store.appendEvent({ conversationId: conv.id, ts, kind: "session_state", payload: { state: "streaming" } });
    store.appendEvent({ conversationId: conv.id, ts, kind: "text_delta", payload: { delta: "a" } });
    store.appendEvent({ conversationId: conv.id, ts, kind: "text_delta", payload: { delta: "b" } });
    const replay = store.getEventsSince(conv.id, 0);
    expect(replay.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("updates conversation state", () => {
    const store = new Store(":memory:");
    const conv = store.createConversation({ namespace: PLATFORM });
    store.setConversationState(conv.id, "streaming");
    expect(store.getConversation(conv.id, PLATFORM)?.state).toBe("streaming");
  });
});

describe("thread columns migration", () => {
  it("adds status + spec blob columns idempotently", () => {
    const tmp = mkdtempSync(join(tmpdir(), "store-mig-"));
    const dbPath = join(tmp, "test.db");
    const db = new Database(dbPath);
    try {
      // Fresh pre-migration schema (no status / spec_* columns). One legacy
      // row inserted so we can verify the new NOT NULL `status` default.
      db.exec(`
        CREATE TABLE conversations(
          id TEXT PRIMARY KEY,
          title TEXT,
          workspace TEXT,
          namespace TEXT NOT NULL DEFAULT 'platform',
          state TEXT NOT NULL DEFAULT 'idle',
          created_at TEXT NOT NULL
        );
        INSERT INTO conversations(id, title, workspace, state, created_at)
          VALUES('conv_legacy', 'old', NULL, 'idle', '2026-01-01T00:00:00.000Z');
      `);
      runMigrations(db);
      // Re-running must not throw.
      runMigrations(db);
      const cols = db
        .prepare("PRAGMA table_info(conversations)")
        .all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain("status");
      expect(names).toContain("spec_draft");
      expect(names).toContain("spec_questions");
      expect(names).toContain("spec_answers");
      // Existing rows get the 'draft' default for the new NOT NULL column,
      // and the spec blob columns start NULL.
      const row = db
        .prepare(
          "SELECT status, spec_draft, spec_questions, spec_answers FROM conversations WHERE id = 'conv_legacy'",
        )
        .get() as {
        status: string;
        spec_draft: string | null;
        spec_questions: string | null;
        spec_answers: string | null;
      };
      expect(row.status).toBe("draft");
      expect(row.spec_draft).toBeNull();
      expect(row.spec_questions).toBeNull();
      expect(row.spec_answers).toBeNull();
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runMigrations is a no-op on a database without the conversations table", () => {
    // Common case: a tool opens a fresh in-memory db and calls runMigrations
    // defensively before knowing whether the schema has been created yet.
    const db = new Database(":memory:");
    try {
      expect(() => runMigrations(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("Store construction runs the migration so legacy rows land with status='draft'", () => {
    const dbPath = join(tmpdir(), `aelvyril-mig-store-${randomUUID()}.db`);
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE conversations(
        id TEXT PRIMARY KEY,
        title TEXT,
        workspace TEXT,
        state TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL
      );
      INSERT INTO conversations(id, title, workspace, state, created_at)
        VALUES('conv_x', 'legacy', NULL, 'idle', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();
    try {
      const store = new Store(dbPath);
      store.close();
      const check = new Database(dbPath, { readonly: true });
      try {
        const row = check
          .prepare("SELECT status FROM conversations WHERE id = 'conv_x'")
          .get() as { status: string };
        expect(row.status).toBe("draft");
      } finally {
        check.close();
      }
    } finally {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // best-effort cleanup; Windows can briefly hold the handle after close
      }
    }
  });
});
