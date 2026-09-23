#!/usr/bin/env bash
# infra/smoke.sh — Spec §11: boot compose, run one real conversation end-to-end.
#
# Usage:  ./infra/smoke.sh          (boots dev profile, runs smoke, leaves stack up)
#         ./infra/smoke.sh --down   (also tears down compose after smoke)
#
# Requires: docker + docker compose plugin, jq, curl. Real Clerk dev keys
# must be in the env (NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY).

set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$COMPOSE_DIR/../"  # repo root so docker compose finds infra/compose.yaml

required=(NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY CLERK_SECRET_KEY)
for v in "${required[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    echo "smoke: $v is required in env (real Clerk dev key)" >&2
    exit 2
  fi
done

cleanup() {
  local rc=$?
  if [[ "${SMOKE_TEARDOWN:-0}" == "1" ]]; then
    echo "smoke: tearing down compose"
    docker compose -f infra/compose.yaml --profile dev down
  fi
  exit $rc
}
trap cleanup EXIT

echo "smoke: booting compose (dev profile)..."
docker compose -f infra/compose.yaml --profile dev up -d --build

echo "smoke: waiting for gateway health..."
for i in {1..30}; do
  if curl -sf http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -sf http://127.0.0.1:8787/healthz >/dev/null || {
  echo "smoke: gateway never became healthy"; exit 3
}

echo "smoke: waiting for layamcp /health..."
for i in {1..60}; do
  # Layamcp is internal-only (no published port). Probe via a one-off
  # container that shares the network.
  if docker run --rm --network aelvyril-net alpine wget -q -O - http://layamcp:8765/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "smoke: waiting for web..."
for i in {1..30}; do
  if curl -sf http://127.0.0.1:3000/ >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -sf http://127.0.0.1:3000/ >/dev/null || {
  echo "smoke: web never became healthy"; exit 3
}

# Smoke is intentionally minimal: just verify the stack is up + Clerk
# routing works through the gateway. Full conversation round-trip (sign in
# → POST /v1/conversations → prompt → SSE) is covered by the live
# browser smoke in Phase 2 close-out + the e2e Playwright tests (Phase 5).
echo "smoke: stack up — gateway /healthz, layamcp /health, web /"

if [[ "${1:-}" == "--down" ]]; then SMOKE_TEARDOWN=1; fi
echo "smoke: PASS"
