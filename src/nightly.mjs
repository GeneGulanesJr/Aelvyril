#!/usr/bin/env node
// Aelvyril nightly consolidation driver — CLI wrapper around merge/glm/digest.
// Usage: node nightly.mjs --db /data/app/vault.db [--inbox /data/inbox] [--skip-glm]
import { openVault } from "./src/lib/db.mjs";
import { runMerge } from "./src/merge.mjs";
import { consolidateConflicts, glmConfigFromEnv } from "./src/glm-consolidate.mjs";
import { writeDigests } from "./src/digest.mjs";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const dbPath = opt("db", "/data/app/vault.db");
const inboxDir = opt("inbox", "/data/inbox");
const reportsDir = opt("reports", "/data/reports");
const digestsDir = opt("digests", "/data/digests");

mkdirSync(reportsDir, { recursive: true });
mkdirSync(digestsDir, { recursive: true });
mkdirSync(inboxDir, { recursive: true });

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const db = openVault(dbPath);

// Pass A: ingest + promote
const result = runMerge(db, inboxDir, { reportsDir });
log(`pass A: staged=${result.staged ?? "?"} promoted=${result.promoted ?? "?"} conflicts=${result.conflicts?.length ?? 0} superseded=${result.superseded ?? 0}`);

// Pass B: GLM consolidation (optional)
let glm = glmConfigFromEnv();
if (flag("skip-glm")) glm = null;
if (!glm) {
  log("pass B: skipped (no GLM config)");
} else if (result.conflicts?.length) {
  try {
    const r = await consolidateConflicts(db, result.conflicts, glm);
    log(`pass B: merged=${r.merged ?? 0} contradicts=${r.contradicts ?? 0}`);
  } catch (e) {
    log(`pass B: error — ${e.message} (pass A output stands)`);
  }
} else {
  log("pass B: no conflicts to resolve");
}

// Digests
const files = await writeDigests(db, digestsDir);
log(`digests: ${files.length ? files.join(", ") : "none"}`);
