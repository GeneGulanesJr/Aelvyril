#!/usr/bin/env bash
# Aelvyril nightly consolidation — cron entry (03:00 server time).
# Runs inside the aelvyril-server container. Data root: /data
set -euo pipefail

cd /data/app
export NODE_ENV=production

LOG=/data/reports/cron.log
mkdir -p /data/reports
echo "=== aelvyril nightly $(date -Is) ===" >> "$LOG"

node src/merge.mjs --inbox /data/inbox --db /data/app/vault.db >> "$LOG" 2>&1

# Pass B: only if GLM configured
if [ -n "${GLM_API_KEY:-}" ]; then
  node src/glm-consolidate.mjs --db /data/app/vault.db >> "$LOG" 2>&1
fi

node src/digest.mjs --db /data/app/vault.db --out /data/digests >> "$LOG" 2>&1
echo "=== done $(date -Is) ===" >> "$LOG"
