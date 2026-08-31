#!/usr/bin/env bash
# Aelvyril nightly consolidation — cron entry (03:00 server time).
# Runs inside the aelvyril-server container. Data root: /data
set -euo pipefail

cd /data/app
export NODE_ENV=production
# Optional GLM config (pass B): GLM_BASE_URL, GLM_API_KEY, GLM_MODEL, GLM_API
[ -f /data/setup/glm.env ] && . /data/setup/glm.env && export GLM_BASE_URL GLM_API_KEY GLM_MODEL GLM_API

LOG=/data/reports/cron.log
mkdir -p /data/reports
echo "=== aelvyril nightly $(date -Is) ===" >> "$LOG"

node src/nightly.mjs --db /data/app/vault.db --inbox /data/inbox >> "$LOG" 2>&1
echo "=== done $(date -Is) ===" >> "$LOG"
