# Foreground and container operation

`run` owns the complete worker process tree. It blocks, writes child output to its own stdout/stderr, forwards `SIGINT` and `SIGTERM`, and stops the remaining children when any required child exits.

```text
container or workspace supervisor
└─ t3-fauxpencode run
   ├─ shim :41874
   ├─ T3 :3773
   └─ frpc (when configured)
```

Run it from the project directory the worker may modify:

```sh
T3_WORKER_HOME=/var/lib/t3-fauxpencode \
t3-fauxpencode run --frpc-config /etc/t3-fauxpencode/frpc.toml
```

Omit `--frpc-config` when no tunnel is required. Once installed, the managed config is reused on later runs. FRPC is pinned to 0.71.0; its archive is verified against the release SHA-256 before extraction.

## Probes and pairing

The health command exits zero only when every required component is healthy. Its JSON includes the operating mode and separate shim, T3, and FRPC states:

```sh
t3-fauxpencode health --json
t3-fauxpencode connection
```

`connection` reads the managed FRP config and persistent T3 identity from `T3_WORKER_HOME`; it does not require this source checkout. When ingress does not use FRPC, set `T3_PUBLIC_URL` to the externally reachable T3 URL before running `connection`.

## Runtime requirements

- Bun and Bash are required.
- `curl`, `tar`, and CA certificates are required for the first FRPC installation.
- Outbound npm access is required when Bun first resolves the pinned T3 package.
- The project working directory must be writable for agent work.
- `T3_WORKER_HOME` must be writable and persistent when identity, sessions, or the downloaded FRPC binary must survive a restart. It contains T3 state, Pi sessions, PM2 state for detached mode, FRPC files, and foreground runtime state.

## Minimal container example

This image uses the foreground supervisor directly; PM2 and a long-lived shell are not part of the process tree.

```dockerfile
FROM oven/bun:1.4.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl tar \
 && rm -rf /var/lib/apt/lists/* \
 && bun install --global t3-fauxpencode@latest

WORKDIR /workspace
ENV T3_WORKER_HOME=/var/lib/t3-fauxpencode
VOLUME ["/var/lib/t3-fauxpencode"]
EXPOSE 3773

HEALTHCHECK CMD ["t3-fauxpencode", "health", "--json"]
CMD ["t3-fauxpencode", "run"]
```

For FRPC, mount its TOML and change the command to:

```dockerfile
CMD ["t3-fauxpencode", "run", "--frpc-config", "/etc/t3-fauxpencode/frpc.toml"]
```
