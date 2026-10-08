#!/usr/bin/env bash
# infra/smoke.sh — Spec §11: boot compose, run one real conversation end-to-end.
#
# Usage:  ./infra/smoke.sh          (boots dev profile, runs smoke, leaves stack up)
#         ./infra/smoke.sh --down   (also tears down compose after smoke)
#
# Requires: docker + docker compose plugin, curl. Local dev mode uses
# infra/.env (Clerk disabled + PI_FAKE) — no real keys needed.

set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$COMPOSE_DIR"  # repo root so docker compose finds infra/compose.yaml

# Canonical env location is infra/.env (compose auto-loads it from the
# project dir); source it here so the mode flags below are visible.
if [[ -f "$COMPOSE_DIR/infra/.env" ]]; then
  set -a; source "$COMPOSE_DIR/infra/.env"; set +a
fi

# Parse arguments FIRST: --down must tear down on EVERY exit path
# (preflight failure included), not only after a clean run. The EXIT trap
# below preserves the script's rc through the teardown.
SMOKE_TEARDOWN=0
for arg in "$@"; do
  case "$arg" in
    --down) SMOKE_TEARDOWN=1 ;;
    *)
      echo "smoke: unknown argument: $arg (usage: smoke.sh [--down])" >&2
      exit 2
      ;;
  esac
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

if [[ "${NEXT_PUBLIC_AUTH_DISABLED:-}" != "1" && "${PI_FAKE:-}" != "1" ]]; then
  echo "smoke: set NEXT_PUBLIC_AUTH_DISABLED=1 + PI_FAKE=1 in infra/.env (local dev)," \
       "or provide real Clerk keys in the env" >&2
  exit 2
fi

# Compose binds GATEWAY_HOST="::" inside the container; the fake verifier
# refuses non-loopback binds unless explicitly acknowledged (index.ts guard).
# Without this third var the gateway crash-loops and smoke dies on a generic
# "never became healthy" — fail fast with the actionable message instead.
if [[ "${PI_FAKE:-}" == "1" && -z "${CLERK_SECRET_KEY:-}" && "${PI_FAKE_ALLOW_NON_LOOPBACK:-}" != "1" ]]; then
  echo "smoke: PI_FAKE=1 without Clerk keys requires PI_FAKE_ALLOW_NON_LOOPBACK=1 in infra/.env" \
       "(compose binds GATEWAY_HOST=:: inside the container)" >&2
  exit 2
fi

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

# layamcp health is probed transitively: compose sets LAYAMCP_URL on the
# gateway, so a 200 from /healthz below implies the decision engine's port
# answered its TCP probe. (depends_on is service_started only — boot order,
# not readiness — see compose.yaml.)

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

echo "smoke: PASS"
