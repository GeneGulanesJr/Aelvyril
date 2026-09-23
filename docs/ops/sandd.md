# PiSandboxed (sandd) ops runbook

`sandd` is the sandbox orchestrator. Runs untrusted code in microVMs via
libkrun. Requires `/dev/kvm` hardware passthrough (spec §9).

## Hard constraints (research 2026-09-22)

- **Bind host is HARDCODED 127.0.0.1** in `src/server/main.ts:59`. No
  `SANDD_HOST` env var exists upstream. The gateway reaches `sandd`
  via `network_mode: host` in compose (dev/prod) — without that, the
  bridge network can't reach `127.0.0.1` inside the container.
- **Auth is file-only.** `~/.pisandboxed/token` at `0600`, NO env var.
  Operator pre-seeds the `sandd-token` volume:
  ```sh
  docker run --rm -v sandd-token:/out alpine \
      sh -c "echo TOKEN > /out/token && chmod 0600 /out/token"
  ```
  The Dockerfile mounts it at `/token/token`.
- **`POST /sandboxes` `project` paths are host-resolved verbatim.**
  Mounts must be valid inside sandd's own mount namespace. If a
  workspace path doesn't exist on the host, the sandbox fails to
  start (not a gateway error).

## Common errors

### `EACCES /dev/kvm`

The host doesn't have KVM exposed, or the container doesn't have device
passthrough. Verify:

```sh
ls -la /dev/kvm  # on host
docker compose -f infra/compose.yaml exec sandd ls -la /dev/kvm
```

The compose file grants `devices: /dev/kvm:/dev/kvm` + `cap_add: SYS_ADMIN`.
Without KVM, sandd falls back to TCG (software emulation) which is much
slower — not an error, just slow.

### `connection refused` on 127.0.0.1:7391

Sandd is binding the loopback interface — that's correct. The issue is
the gateway can't reach it. Check `network_mode: host` in compose and
the gateway's `SANDD_URL` (if implemented — currently no direct gateway
→ sandd call; the gateway spawns the child which then talks to sandd).

### Sandbox fails to start

Check `/images` volume has the microVM images. Pre-bake them:

```sh
docker compose -f infra/compose.yaml exec sandd ls /images
```

If empty, pull the base images per PiSandboxed's docs.

## Token rotation

1. Mint a new token in the PiSandboxed dashboard.
2. `docker run --rm -v sandd-token:/out alpine sh -c "echo NEW_TOKEN > /out/token && chmod 0600 /out/token"`
3. `docker compose -f infra/compose.yaml restart sandd`

The gateway picks up the new token on next request (no restart needed
for the gateway — it just forwards Bearer headers).

## Upstream-host fix

Add `SANDD_HOST` upstream support to PiSandboxed, then drop
`network_mode: host` from compose and use `SANDD_HOST=sandd` in the
gateway service. Tracked as Phase 4 deferred work.
