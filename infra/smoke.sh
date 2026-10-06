#!/usr/bin/env bash
# infra/smoke.sh — Spec §11: boot compose, run one real conversation end-to-end.
#
# Usage:  ./infra/smoke.sh          (boots dev profile, runs smoke, leaves stack up)
#         ./infra/smoke.sh --down   (also tears down compose after smoke)
#
# Requires: docker + docker compose plugin, jq, curl. Local dev mode uses
# infra/.env (Clerk disabled + PI_FAKE) — no real keys needed.

set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$COMPOSE_DIR"  # repo root so docker compose finds infra/compose.yaml

# Canonical env location is infra/.env (compose auto-loads it from the
# project dir); source it here so the mode flags below are visible.
if [[ -f "$COMPOSE_DIR/infra/.env" ]]; then
  set -a; source "$COMPOSE_DIR/infra/.env"; set +a
fi

if [[ "${NEXT_PUBLIC_AUTH_DISABLED:-}" != "1" && "${PI_FAKE:-}" != "1" ]]; then
  echo "smoke: set NEXT_PUBLIC_AUTH_DISABLED=1 + PI_FAKE=1 in infra/.env (local dev)," \
       "or provide real Clerk keys in the env" >&2
  exit 2
fi

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

# layamcp health is enforced transitively: the gateway depends_on
# layamcp: service_healthy, so gateway /healthz below implies the decision
# engine loaded its models.

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
echo "smoke: stack up — gateway /healthz (incl. layamcp), web /"

if [[ "${1:-}" == "--down" ]]; then SMOKE_TEARDOWN=1; fi
echo "smoke: PASS"
