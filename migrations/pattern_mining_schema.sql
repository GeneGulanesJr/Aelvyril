-- Pattern Mining schema extension for Aelvyril
-- Run: sqlite3 <data_dir>/audit.db < schema_pattern_mining.sql

-- PII examples captured for pattern mining (raw PII, purged after mining)
CREATE TABLE IF NOT EXISTS pii_examples (
    id                TEXT PRIMARY KEY,
    task_id           TEXT NOT NULL,
    session_id        TEXT NOT NULL,
    entity_type       TEXT NOT NULL,
    raw_value         TEXT NOT NULL,
    normalized_value  TEXT NOT NULL,
    timestamp         TEXT NOT NULL,
    confidence        REAL NOT NULL,
    source            TEXT NOT NULL DEFAULT 'presidio',
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pii_examples_task ON pii_examples(task_id);
CREATE INDEX IF NOT EXISTS idx_pii_examples_type ON pii_examples(entity_type);
CREATE INDEX IF NOT EXISTS idx_pii_examples_session ON pii_examples(session_id);

-- Pattern mining run metadata
CREATE TABLE IF NOT EXISTS pattern_mining_runs (
    id               TEXT PRIMARY KEY,
    task_id          TEXT NOT NULL,
    state            TEXT NOT NULL,
    started_at       TEXT NOT NULL,
    completed_at     TEXT,
    examples_count   INTEGER NOT NULL DEFAULT 0,
    clusters_count   INTEGER NOT NULL DEFAULT 0,
    patterns_count   INTEGER NOT NULL DEFAULT 0,
    deployed_count   INTEGER NOT NULL DEFAULT 0,
    error_log        TEXT NOT NULL DEFAULT '[]',
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mining_runs_task ON pattern_mining_runs(task_id);

-- Clustering results per mining run
CREATE TABLE IF NOT EXISTS mining_clusters (
    id            TEXT PRIMARY KEY,
    run_id        TEXT NOT NULL,
    entity_type   TEXT NOT NULL,
    centroid      TEXT NOT NULL,           -- Representative normalized value
    example_count INTEGER NOT NULL,
    examples_json TEXT NOT NULL,           -- Array of raw_value for LFM prompt
    FOREIGN KEY(run_id) REFERENCES pattern_mining_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_clusters_run ON mining_clusters(run_id);

-- Generated regex patterns per cluster
CREATE TABLE IF NOT EXISTS generated_patterns (
    id            TEXT PRIMARY KEY,
    cluster_id    TEXT NOT NULL,
    pattern_text  TEXT NOT NULL,
    confidence    REAL NOT NULL,
    validator     TEXT,                     -- 'luhn', 'iban', or null
    FOREIGN KEY(cluster_id) REFERENCES mining_clusters(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_patterns_cluster ON generated_patterns(cluster_id);

-- Validation results (sample-based precision/recall)
CREATE TABLE IF NOT EXISTS pattern_validation (
    id              TEXT PRIMARY KEY,
    pattern_id      TEXT NOT NULL,
    sample_size     INTEGER NOT NULL,
    precision       REAL NOT NULL,
    recall          REAL NOT NULL,
    validated_at    TEXT NOT NULL,
    approved        INTEGER NOT NULL DEFAULT 0, -- 0=pending, 1=approved, 2=rejected
    approved_by     TEXT,
    approved_at     TEXT,
    notes           TEXT,
    FOREIGN KEY(pattern_id) REFERENCES generated_patterns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_validation_pattern ON pattern_validation(pattern_id);
