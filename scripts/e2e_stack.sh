#!/usr/bin/env bash
# One-shot Aelvyril live-E2E stack: sidecar (3031) + mock upstream (9999) +
# headless gateway (4242), then the 40-type corpus matrix, then cleanup by PID.
#
# This is the repo-resident copy of the Hermes skill's canonical one-shot
# bring-up script. Run it from the repo root after building the headless
# binary (see prereqs). It uses the in-repo scripts/ directly.
#
# Prereqs (on the devbox / a runner with the ML stack):
#   - headless binary built:
#       export PATH=$HOME/.cargo/bin:$PATH
#       cd /workspace/aelvyril
#       CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_DEV_CODEGEN_UNITS=16 CARGO_BUILD_JOBS=1 \
#         cargo build --manifest-path src-tauri/Cargo.toml --bin aelvyril-headless
#   - sidecar venv /root/venvs/sidecar (or $SIDECAR_VENV) with the Liquid
#     model snapshot cached (~/.aelvyril/models) — first /liquid/pii warms
#     up ~13s.
#
# Since 2026-08-07 the provider key comes from the AELVYRIL_KEY_<PROVIDER> env
# override, so NO dbus/gnome-keyring setup is needed. Cleanup kills by PID —
# never pkill -f over ssh (the remote cmdline contains the pattern → kills
# your own session). Verify ports are free first if a previous run left
# orphans:
#   ps -eo pid,cmd | grep -E "presidio_service|aelvyril-headless|mock_upstream" | grep -v grep
#
# CRITICAL (2026-08-07): the headless bin wires the engine's Presidio+Liquid
# clients from PRESIDIO_HOST/PRESIDIO_PORT (defaults 127.0.0.1:3000) via
# set_presidio_url (PR #67 / 7c9ea52). You MUST set PRESIDIO_PORT on the
# HEADLESS process too — not just the sidecar — or both NLP layers silently
# fall through and the gateway column is REGEX-ONLY (the 30/40-vs-40/40 bug).
set -u

REPO=${REPO:-$(cd "$(dirname "$0")/.." && pwd)}
SIDECAR_VENV=${SIDECAR_VENV:-/root/venvs/sidecar}
SIDECAR_PY=${SIDECAR_PY:-$SIDECAR_VENV/bin/python}
PORT_SIDECAR=${PORT_SIDECAR:-3031}   # NOT 3000 — devbox shares host network; 3000 is GulanesKorp
PORT_MOCK=${PORT_MOCK:-9999}
PORT_HEADLESS=${PORT_HEADLESS:-4242}
MOCK_LOG=${MOCK_LOG:-/tmp/mock_upstream.log}
SIDECAR_LOG=${SIDECAR_LOG:-/tmp/sidecar.log}
HEADLESS_LOG=${HEADLESS_LOG:-/tmp/headless.log}

cd "$REPO" || { echo "REPO ($REPO) not found" >&2; exit 1; }

# Truncate logs so each run starts clean.
: > "$MOCK_LOG"

# ── 1. Sidecar (Presidio analyzer + Liquid PII encoder) ─────────────────────
PRESIDIO_PORT=$PORT_SIDECAR AELVYRIL_LIQUID_PII_ENABLED=1 \
  nohup "$SIDECAR_PY" src-tauri/presidio_service.py > "$SIDECAR_LOG" 2>&1 &
S=$!

# ── 2. Mock OpenAI-compatible upstream ─────────────────────────────────────
# mock_upstream.py <port> <log_path>  (log path is a CLI arg)
nohup python3 scripts/mock_upstream.py "$PORT_MOCK" "$MOCK_LOG" > /tmp/mock.out 2>&1 &
M=$!

# ── 3. Headless gateway (benchmark mode, no keyring needed) ────────────────
PRESIDIO_PORT=$PORT_SIDECAR AELVYRIL_KEY_BENCHMARKDUMMY=aelvyril-benchmark-key \
  nohup "$REPO/src-tauri/target/debug/aelvyril-headless" > "$HEADLESS_LOG" 2>&1 &
G=$!

cleanup() {
  kill "$S" "$M" "$G" 2>/dev/null
}
trap cleanup EXIT INT TERM

# ── 4. Health-check loop (all three must answer) ───────────────────────────
echo "Bringing up stack (sidecar=$PORT_SIDECAR mock=$PORT_MOCK headless=$PORT_HEADLESS)..."
for i in $(seq 1 90); do
  ok=1
  curl -s -o /dev/null "http://127.0.0.1:$PORT_SIDECAR/health" || ok=0
  curl -s -o /dev/null "http://127.0.0.1:$PORT_MOCK/" || ok=0
  curl -s -o /dev/null "http://127.0.0.1:$PORT_HEADLESS/health" || ok=0
  [ "$ok" -eq 1 ] && { echo "ALL_UP after ${i}s"; break; }
  sleep 1
done

if [ "$ok" != "1" ]; then
  echo "STACK FAILED to come up within 90s — see logs:" >&2
  echo "  sidecar:  $SIDECAR_LOG" >&2
  echo "  mock:     $MOCK_LOG" >&2
  echo "  headless: $HEADLESS_LOG" >&2
  exit 1
fi

# ── 5. Run the 40-type corpus ──────────────────────────────────────────────
python3 scripts/corpus_test.py
CORPUS_RC=$?

# Also run the focused rehydration smoke test if present.
if [ -f scripts/e2e_test.py ]; then
  "$SIDECAR_VENV/bin/python" scripts/e2e_test.py || true
fi

echo "--- headless log tail ---"
tail -4 "$HEADLESS_LOG"

exit "$CORPUS_RC"
