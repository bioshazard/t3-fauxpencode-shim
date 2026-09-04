# RCA: FRPC reports `no route to host` while PM2-managed

**Status:** Resolved by rebuilding the PM2 daemon and local process tree.

## Symptoms

The optional `frpc-local` PM2 process repeatedly exited with:

```text
connect to server error: dial tcp <frp-server>:<port>: connect: no route to host
login to the server failed ... With loginFailExit enabled, no additional retries will be attempted
```

PM2 eventually marked it `errored` after repeated restarts. T3 was therefore not reachable through the public FRP hostname.

## What was ruled out

- There was no other running `frpc` process or local port conflict.
- `~/frpc.toml` and the managed copy at `~/.local/share/t3-fauxpencode/frp/frpc.toml` had identical checksums.
- T3 was listening on the configured target, `127.0.0.1:3773`.
- DNS resolved the configured FRP server, and a TCP probe to its configured port succeeded.
- Starting the managed `frpc` binary directly with `~/frpc.toml` successfully logged in and registered its configured proxy.

## Cause

The failure was isolated to the existing PM2 daemon/process tree: it continued getting `no route to host` even after direct `frpc` execution using the same binary and byte-identical configuration connected successfully. The precise macOS/PM2 networking mechanism was not identified, so treat this as a stale PM2 network-state diagnosis rather than a configuration defect.

## Recovery

Rebuild the PM2 daemon and start the complete local FRP stack:

```sh
cd /path/to/t3-fauxpencode
bunx pm2@7.0.4 kill
PI_FRPC_LOCAL=1 bunx pm2@7.0.4 start ecosystem.config.cjs --update-env
```

Or use the project command when a full restart is acceptable:

```sh
bun run restart:local:frp
```

The first command is useful when explicitly clearing a potentially stale PM2 process tree. It briefly interrupts the shim and T3 as well as FRPC.

## Verification

```sh
bunx pm2@7.0.4 ls
bunx pm2@7.0.4 logs frpc-local --lines 30 --nostream
curl -sS -o /dev/null -w '%{http_code}\n' https://<public-frp-host>/
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:41874/provider
```

A healthy FRPC log includes both `login to server success` and `start proxy success`.
