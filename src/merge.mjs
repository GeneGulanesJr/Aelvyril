/**
 * Nightly consolidation pass A (deterministic, rule-based).
 *
 * mergeBatch(vaultDb, batch): upsert batch rows into staging_observations
 *   keyed (origin_instance, source_id) and record supersession pairs in
 *   staging_relations.
 * runPromote(vaultDb): move staging → canonical observations with exact
 *   (project, topic_key, title) dedup (newest updated_at wins), apply
 *   superseded relations as soft-deletes, rebuild FTS, bump last_merge_at.
 * runMerge(vaultDb, inboxDir): ingest inbox/<instance>/*.json oldest-first,
 *   promote, write conflict report, archive processed files.
 */
import { readdirSync, readFileSync, renameSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDistillable } from './lib/filter.mjs';

const STAGING_COLS = [
  'source_id', 'origin_instance', 'session_id', 'type', 'title', 'content',
  'project', 'scope', 'topic_key', 'expires_at', 'created_at', 'updated_at', 'deleted_at',
];

/** Upsert one batch into staging. Returns {upserted, superseded}. */
export function mergeBatch(db, batch) {
  const instance = batch.instance;
  const upsert = db.prepare(`
    INSERT INTO staging_observations (${STAGING_COLS.join(', ')})
    VALUES (${STAGING_COLS.map(() => '?').join(', ')})
    ON CONFLICT (origin_instance, source_id) DO UPDATE SET
      session_id = excluded.session_id,
      type = excluded.type,
      title = excluded.title,
      content = excluded.content,
      project = excluded.project,
      scope = excluded.scope,
      topic_key = excluded.topic_key,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at
  `);

  const insertRel = db.prepare(`
    INSERT INTO staging_relations (source_id, target_id, relation, origin_instance)
    VALUES (?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `);

  db.exec('BEGIN');
  try {
    let upserted = 0;
    for (const r of batch.rows ?? []) {
      upsert.run(
        r.id, instance, r.session_id, r.type, r.title, r.content,
        r.project ?? null, r.scope ?? 'project', r.topic_key ?? null,
        r.expires_at ?? null, r.created_at, r.updated_at, r.deleted_at ?? null,
      );
      upserted++;
    }
    let superseded = 0;
    for (const s of batch.superseded_ids ?? []) {
      // Batch contract: {source_id, relation, newer_source_id} — source_id is
      // the superseded row, newer_source_id is what replaces it.
      insertRel.run(s.source_id, s.newer_source_id, s.relation ?? 'supersedes', instance);
      superseded++;
    }
    db.exec('COMMIT');
    return { upserted, superseded };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Promote staging → canonical. Idempotent: staging rows already promoted
 * (canonical_id set) are skipped. Dedups exact (project, topic_key, title),
 * newest updated_at wins. Soft-deletes canonical rows that match a
 * superseded staging row. Rebuilds FTS, bumps vault_instances.last_merge_at.
 */
export function runPromote(db) {
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    // Promote unpromoted, distillable staging rows oldest-first so newest
    // updated_at wins on exact-match dedup.
    const pending = db.prepare(`
      SELECT * FROM staging_observations
      WHERE canonical_id IS NULL
      ORDER BY updated_at ASC, id ASC
    `).all();

    const findExisting = db.prepare(`
      SELECT id, updated_at FROM observations
      WHERE deleted_at IS NULL AND project IS ? AND topic_key IS ? AND title = ?
      LIMIT 1
    `);
    const insert = db.prepare(`
      INSERT INTO observations
        (session_id, type, title, content, project, scope, topic_key,
         expires_at, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const overwrite = db.prepare(`
      UPDATE observations SET content = ?, updated_at = ?, deleted_at = ?, expires_at = ?
      WHERE id = ?
    `);

    for (const s of pending) {
      const existing = findExisting.get(s.project ?? null, s.topic_key ?? null, s.title);
      if (existing) {
        // Keep newest updated_at. If the staging row is newer (and not
        // already soft-deleted upstream), it wins; else the staging row is
        // absorbed (dropped) by the existing canonical row.
        const sNewer = (s.updated_at ?? '') > (existing.updated_at ?? '');
        if (sNewer && !s.deleted_at) {
          overwrite.run(s.content, s.updated_at, null, s.expires_at ?? null, existing.id);
        }
        db.prepare('UPDATE staging_observations SET canonical_id = ? WHERE id = ?')
          .run(existing.id, s.id);
      } else {
        const res = insert.run(
          s.session_id, s.type, s.title, s.content,
          s.project ?? null, s.scope ?? 'project', s.topic_key ?? null,
          s.expires_at ?? null, s.created_at, s.updated_at, s.deleted_at,
        );
        db.prepare('UPDATE staging_observations SET canonical_id = ? WHERE id = ?')
          .run(Number(res.lastInsertRowid), s.id);
      }
    }

    // Apply supersessions: canonical rows promoted from a staging row that a
    // relation supersedes get soft-deleted (after promotion, canonical_id known).
    db.prepare(`
      UPDATE observations SET deleted_at = ?
      WHERE deleted_at IS NULL AND id IN (
        SELECT s.canonical_id FROM staging_relations r
        JOIN staging_observations s
          ON s.origin_instance = r.origin_instance AND s.source_id = r.source_id
        WHERE s.canonical_id IS NOT NULL
      )
    `).run(now);

    db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Mark merge bookkeeping for every instance that contributed staging rows.
  const contributors = db.prepare('SELECT DISTINCT origin_instance FROM staging_observations').all();
  for (const { origin_instance } of contributors) {
    db.prepare(`
      INSERT INTO vault_instances (name, last_merge_at) VALUES (?, ?)
      ON CONFLICT (name) DO UPDATE SET last_merge_at = excluded.last_merge_at
    `).run(origin_instance, now);
  }

  return { promotedAt: now };
}

/** Write conflicts report and return the conflicts array. */
function collectConflicts(db, reportsDir, dateStamp) {
  // Same (project, topic_key), different titles, from different instances.
  const groups = db.prepare(`
    SELECT project, topic_key
    FROM staging_observations
    WHERE canonical_id IS NOT NULL AND deleted_at IS NULL
      AND project IS NOT NULL AND topic_key IS NOT NULL
    GROUP BY project, topic_key
    HAVING COUNT(DISTINCT title) > 1
  `).all();

  const conflicts = [];
  for (const g of groups) {
    const titles = db.prepare(`
      SELECT title, origin_instance, updated_at, canonical_id
      FROM staging_observations
      WHERE project = ? AND topic_key = ? AND deleted_at IS NULL AND canonical_id IS NOT NULL
    `).all(g.project, g.topic_key);
    const instances = new Set(titles.map((t) => t.origin_instance));
    if (instances.size < 2) continue; // same instance, different titles = normal
    conflicts.push({ project: g.project, topic_key: g.topic_key, titles });
  }

  if (conflicts.length && reportsDir) {
    mkdirSync(reportsDir, { recursive: true });
    const file = join(reportsDir, `conflicts-${dateStamp}.md`);
    const lines = [
      `# Conflicts — ${dateStamp}`,
      '',
      'Same (project, topic_key) recorded with different titles across instances.',
      '',
    ];
    for (const c of conflicts) {
      lines.push(`## ${c.project} / ${c.topic_key}`, '');
      for (const t of c.titles) {
        lines.push(`- **${t.title}** — from \`${t.origin_instance}\` (updated ${t.updated_at}, canonical id ${t.canonical_id})`);
      }
      lines.push('');
    }
    writeFileSync(file, lines.join('\n'));
  }
  return conflicts;
}

const DATE_STAMP = () => new Date().toISOString().slice(0, 10);

/**
 * Ingest all inbox/<instance>/*.json oldest-first, mergeBatch each, promote,
 * collect conflicts (optionally writing reports/conflicts-<date>.md when
 * opts.reportsDir given), archive processed files to processed/.
 */
export function runMerge(db, inboxDir, opts = {}) {
  const dateStamp = DATE_STAMP();
  const instanceDirs = readdirSync(inboxDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'processed')
    .map((d) => d.name);

  let processed = 0;
  for (const instance of instanceDirs.sort()) {
    const dir = join(inboxDir, instance);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) {
      const batch = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      mergeBatch(db, batch);
      processed++;
    }
  }

  runPromote(db);
  const conflicts = collectConflicts(db, opts.reportsDir, dateStamp);

  // Archive processed files.
  for (const instance of instanceDirs) {
    const dir = join(inboxDir, instance);
    const outDir = join(dir, 'processed');
    mkdirSync(outDir, { recursive: true });
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      renameSync(join(dir, f), join(outDir, f));
    }
  }

  return { processed, conflicts, promotedAt: dateStamp };
}
