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

# Preflight: at least one of these auth modes must be configured before
# compose boots. Local dev uses NEXT_PUBLIC_AUTH_DISABLED=1 + PI_FAKE=1 in
# infra/.env (no real keys needed); a real Clerk integration needs both
# NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (build-arg into web) and CLERK_SECRET_KEY
# (runtime, web+gateway) — see the build args under the `web` service.
# Previously the second path was unreachable — the preflight refused unless
# the dev flags were set, regardless of Clerk keys.
if [[ "${NEXT_PUBLIC_AUTH_DISABLED:-}" != "1" && "${PI_FAKE:-}" != "1" ]]; then
  # Not in dev mode: require BOTH Clerk keys. Half-configured Clerk will
  # fail inside the gateway/web container with a less actionable error.
  if [[ -z "${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:-}" || -z "${CLERK_SECRET_KEY:-}" ]]; then
    echo "smoke: configure one of:" >&2
    echo "  - local dev: NEXT_PUBLIC_AUTH_DISABLED=1 + PI_FAKE=1 in infra/.env" >&2
    echo "  - real Clerk: NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY in the env" >&2
    exit 2
  fi
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

# Review 2026-10-15: create the workspaces host dir before `compose up`.
# Docker creates missing bind-mount source dirs as root:root 0755, which the
# uid-1001 gateway can't enter (EACCES on every git/file op). -p is a no-op
# when the dir already exists; we don't chown — the operator is expected to
# own an existing dir (see infra/README.md).
# Compose resolves a relative path against infra/ (the compose file's dir).
ws_host="${WORKSPACES_HOST_PATH:-./workspaces}"
[[ "$ws_host" == /* ]] || ws_host="$COMPOSE_DIR/infra/$ws_host"
mkdir -p "$ws_host"

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
