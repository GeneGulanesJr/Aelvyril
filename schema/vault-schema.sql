-- Aelvyril vault schema (Phase 1)
-- observations + FTS + relations copied verbatim from LaPis schema/lapis-schema.reference.sql.
-- Additions: staging_observations (delta inbox), vault_meta, vault_instances.

-- ═══════════════════════════════════════════════════════════
-- OBSERVATIONS (verbatim from LaPis)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS observations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  project    TEXT,
  scope      TEXT    NOT NULL DEFAULT 'project',
  topic_key  TEXT,
  expires_at TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_obs_session  ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_obs_type     ON observations(type);
CREATE INDEX IF NOT EXISTS idx_obs_project  ON observations(project);
CREATE INDEX IF NOT EXISTS idx_obs_scope     ON observations(scope);
CREATE INDEX IF NOT EXISTS idx_obs_topic    ON observations(topic_key, project, scope, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_created  ON observations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_deleted  ON observations(deleted_at);
CREATE INDEX IF NOT EXISTS idx_obs_expires ON observations(expires_at) WHERE expires_at IS NOT NULL;

-- FTS5 for observations (verbatim from LaPis)
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title,
  content,
  type,
  project,
  topic_key,
  content='observations',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS obs_fts_insert AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, content, type, project, topic_key)
  VALUES (new.id, new.title, new.content, new.type, new.project, new.topic_key);
END;

CREATE TRIGGER IF NOT EXISTS obs_fts_delete AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content, type, project, topic_key)
  VALUES ('delete', old.id, old.title, old.content, old.type, old.project, old.topic_key);
END;

CREATE TRIGGER IF NOT EXISTS obs_fts_update AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content, type, project, topic_key)
  VALUES ('delete', old.id, old.title, old.content, old.type, old.project, old.topic_key);
  INSERT INTO observations_fts(rowid, title, content, type, project, topic_key)
  VALUES (new.id, new.title, new.content, new.type, new.project, new.topic_key);
END;

-- ═══════════════════════════════════════════════════════════
-- OBSERVATION RELATIONS (verbatim from LaPis)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS observation_relations (
  source_id     INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  target_id     INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  relation      TEXT NOT NULL,  -- 'duplicate', 'supersedes', 'related'
  confidence    REAL NOT NULL DEFAULT 0.8,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_id, target_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_obs_rel_source ON observation_relations(source_id);
CREATE INDEX IF NOT EXISTS idx_obs_rel_target ON observation_relations(target_id);

-- ═══════════════════════════════════════════════════════════
-- STAGING: delta inbox rows (observations cols + origin/source)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS staging_observations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id       INTEGER NOT NULL,
  origin_instance TEXT    NOT NULL,
  session_id      TEXT    NOT NULL,
  type            TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  content         TEXT    NOT NULL,
  project         TEXT,
  scope           TEXT    NOT NULL DEFAULT 'project',
  topic_key       TEXT,
  expires_at      TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT,
  canonical_id    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_staging_origin_source ON staging_observations(origin_instance, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_staging_origin_source ON staging_observations(origin_instance, source_id);
CREATE INDEX IF NOT EXISTS idx_staging_project ON staging_observations(project);

-- Supersession pairs as received in inbox batches (pre-promotion).
-- (source_id, target_id, relation, origin_instance) where source_id is the
-- superseded local row id and target_id is the newer local row id.
CREATE TABLE IF NOT EXISTS staging_relations (
  source_id       INTEGER NOT NULL,
  target_id       INTEGER NOT NULL,
  relation        TEXT    NOT NULL,
  origin_instance TEXT    NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_staging_rel_origin ON staging_relations(origin_instance, source_id);

-- ═══════════════════════════════════════════════════════════
-- VAULT BOOKKEEPING
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vault_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS vault_instances (
  name          TEXT PRIMARY KEY,
  last_push_at  TEXT,
  last_merge_at TEXT
);
