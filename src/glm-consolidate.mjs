/**
 * Nightly consolidation pass B (optional, semantic): for cross-instance
 * conflicts on the same (project, topic_key) with different titles, ask GLM
 * (OpenAI-compatible chat completions) to merge or flag as contradicting.
 *
 * - merge action: writes the merged row as a new canonical row and soft-
 *   deletes the conflicting source rows (history is preserved, never
 *   silently rewritten — the merged row references its sources).
 * - contradicts: leaves both rows, appends a review entry to
 *   reports/review-<date>.md.
 * - No GLM key: skips gracefully (pass A output stands).
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Typed error thrown when GLM is not configured and the caller must decide. */
export class GlmConfigError extends Error {
  constructor(message = 'GLM not configured: set GLM_BASE_URL, GLM_API_KEY, GLM_MODEL') {
    super(message);
    this.name = 'GlmConfigError';
  }
}

/** Read GLM config from env; null when unset. */
export function glmConfigFromEnv() {
  const baseUrl = process.env.GLM_BASE_URL;
  const apiKey = process.env.GLM_API_KEY;
  const model = process.env.GLM_MODEL;
  const api = process.env.GLM_API; // 'anthropic' | undefined (openai-compatible)
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl, apiKey, model, api };
}

const SYSTEM_PROMPT = `You are a memory-consolidation assistant. Two agents recorded knowledge for the same topic. Decide whether the records can be merged into one coherent memory or whether they contradict each other.
Respond ONLY with a JSON object:
{"action": "merge", "title": "...", "content": "..."}
or
{"action": "contradicts"}`;

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

async function callGlm(fetchFn, cfg, conflict) {
  const userPrompt = [
    `Project: ${conflict.project}`,
    `Topic key: ${conflict.topic_key}`,
    'Records:',
    ...conflict.titles.map((t, i) =>
      `${i + 1}. "${t.title}" — ${t.content ?? '(content in vault)'} (from ${t.origin_instance}, updated ${t.updated_at})`),
    '',
    'Merge into one memory or mark CONTRADICTS. Return JSON.',
  ].join('\n');

  const base = cfg.baseUrl.replace(/\/$/, '');
  let res, data;
  if (cfg.api === 'anthropic') {
    res = await fetchFn(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0.1,
      }),
    });
    if (!res.ok) throw new Error(`GLM API error ${res.status}`);
    data = await res.json();
    var raw = (data.content ?? []).map((b) => b.text ?? '').join('');
  } else {
    res = await fetchFn(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
      }),
    });
    if (!res.ok) throw new Error(`GLM API error ${res.status}`);
    data = await res.json();
    var raw = data.choices?.[0]?.message?.content ?? '';
  }
  // tolerate code fences
  const jsonText = raw.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  return JSON.parse(jsonText);
}

function appendReview(reportsDir, conflict, verdict) {
  if (!reportsDir) return;
  mkdirSync(reportsDir, { recursive: true });
  const file = join(reportsDir, `review-${dateStamp()}.md`);
  let lines = [];
  if (existsSync(file)) {
    lines = readFileSync(file, 'utf8').split('\n');
  } else {
    lines.push(`# Review queue — ${dateStamp()}`, '', 'GLM flagged these as contradictory; human review needed.', '');
  }
  lines.push(`## ${conflict.project} / ${conflict.topic_key}`, '');
  for (const t of conflict.titles) {
    lines.push(`- **${t.title}** — from \`${t.origin_instance}\` (updated ${t.updated_at})`);
  }
  if (verdict) lines.push('', `> GLM verdict: ${verdict}`);
  lines.push('');
  writeFileSync(file, lines.join('\n'));
}

/**
 * consolidateConflicts(vaultDb, conflicts, opts)
 *   opts: {baseUrl, apiKey, model, fetch?, reportsDir?, onSkip?: 'return'}
 *
 * Returns {merged, flagged, skipped?}. When apiKey is missing: throws
 * GlmConfigError, or returns {skipped: true} if opts.onSkip === 'return'.
 */
export async function consolidateConflicts(db, conflicts, opts = {}) {
  const { baseUrl, apiKey, model } = opts;
  if (!baseUrl || !apiKey || !model) {
    if (opts.onSkip === 'return') return { skipped: true, merged: 0, flagged: 0 };
    throw new GlmConfigError();
  }

  const fetchFn = opts.fetch ?? globalThis.fetch;
  const cfg = { baseUrl, apiKey, model };
  let merged = 0;
  let flagged = 0;

  for (const conflict of conflicts) {
    // Pull actual contents for the prompt.
    const titles = conflict.titles.map((t) => ({
      ...t,
      content: db.prepare('SELECT content FROM observations WHERE id = ?').get(t.canonical_id)?.content,
    }));
    const verdict = await callGlm(fetchFn, cfg, { ...conflict, titles });

    if (verdict.action === 'merge') {
      const now = new Date().toISOString();
      db.exec('BEGIN');
      try {
        const res = db.prepare(`
          INSERT INTO observations
            (session_id, type, title, content, project, scope, topic_key,
             expires_at, created_at, updated_at)
          VALUES ('vault-consolidation', 'decision', ?, ?, ?, 'project', ?, NULL, ?, ?)
        `).run(
          verdict.title,
          verdict.content,
          conflict.project,
          conflict.topic_key,
          now, now,
        );
        const mergedId = Number(res.lastInsertRowid);
        // Soft-delete the source rows; record supersedes relations.
        for (const t of titles) {
          db.prepare('UPDATE observations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
            .run(now, t.canonical_id);
          db.prepare(`
            INSERT INTO observation_relations (source_id, target_id, relation, confidence)
            VALUES (?, ?, 'supersedes', 1.0)
            ON CONFLICT DO NOTHING
          `).run(t.canonical_id, mergedId);
        }
        db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      merged++;
    } else {
      // contradicts — leave both rows, queue for human review.
      appendReview(opts.reportsDir, { ...conflict, titles }, verdict.reason);
      flagged++;
    }
  }

  return { merged, flagged };
}
