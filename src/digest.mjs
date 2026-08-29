/**
 * Read path (plan Task 8 / Design decision 6): render the canonical
 * observations DB as one markdown digest per project, grouped by type in a
 * fixed order, newest first, footer with counts. Instances pull these on
 * demand; the vault never writes back into local LaPis DBs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TYPE_ORDER = ['decision', 'architecture', 'bugfix', 'pattern', 'preference', 'learning'];

/**
 * writeDigests(vaultDb, outDir) → list of written file names.
 */
export function writeDigests(db, outDir) {
  mkdirSync(outDir, { recursive: true });

  const projects = db.prepare(`
    SELECT DISTINCT project FROM observations
    WHERE deleted_at IS NULL AND project IS NOT NULL
    ORDER BY project
  `).all();

  const written = [];
  for (const { project } of projects) {
    const rows = db.prepare(`
      SELECT type, title, content, updated_at FROM observations
      WHERE deleted_at IS NULL AND project = ?
      ORDER BY updated_at DESC, id DESC
    `).all(project);

    const lines = [`# ${project} — vault digest`, ''];

    for (const type of TYPE_ORDER) {
      const items = rows.filter((r) => r.type === type);
      if (!items.length) continue;
      lines.push(`## ${type}`, '');
      for (const item of items) {
        lines.push(`### [${type}] ${item.title}`, '', item.content, '');
      }
    }

    const counts = rows.reduce((acc, r) => {
      acc[r.type] = (acc[r.type] ?? 0) + 1;
      return acc;
    }, {});
    const countLine = Object.entries(counts)
      .sort(([a], [b]) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b))
      .map(([t, n]) => `${t}: ${n}`)
      .join(', ');
    lines.push('---', '', `_${rows.length} items — ${countLine}_`, '');

    const file = `${project}.md`;
    writeFileSync(join(outDir, file), lines.join('\n'));
    written.push(file);
  }
  return written;
}
