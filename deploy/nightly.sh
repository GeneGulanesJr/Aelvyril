#!/usr/bin/env bash
# Aelvyril nightly consolidation — cron entry (03:00 server time).
# Runs inside the aelvyril-server container. Data root: /data
set -euo pipefail

cd /data/app
export NODE_ENV=production

LOG=/data/reports/cron.log
mkdir -p /data/reports
echo "=== aelvyril nightly $(date -Is) ===" >> "$LOG"

node src/nightly.mjs --db /data/app/vault.db --inbox /data/inbox >> "$LOG" 2>&1
echo "=== done $(date -Is) ===" >> "$LOG"
