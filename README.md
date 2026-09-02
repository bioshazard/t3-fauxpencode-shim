# T3 Worker

See [`docs/poc.md`](docs/poc.md) for the provisional facade surface and known capture gaps. See [`docs/runbook.md`](docs/runbook.md) for capture, scenario, and verification commands.

Single-machine Bun launcher for an isolated T3 worker backed by Pi sessions. It exposes the OpenCode-shaped surface T3 needs; PM2 and optional FRP are implementation details.

## Run

Run it from the project directory T3 will use. The current directory is the one permitted session root; there are no repo or worker-name flags.

```sh
bunx @bioshazard/t3-worker start
```

The launcher stores its singleton state under `~/.local/share/t3-worker/` (override only for testing with `T3_WORKER_HOME`). It starts PM2-managed shim and T3 processes. The T3 settings are isolated from a normal T3 installation.

## FRP

Pass a complete client configuration on the first start:

```sh
bunx @bioshazard/t3-worker start --frpc-config ~/frpc.toml
```

The config is copied to the worker state directory and enables a third PM2 process. On its first use, the launcher downloads the matching official `frpc` binary for macOS/Linux `amd64` or `arm64`.

FRP must target T3, not the shim:

```toml
serverAddr = "frp.example.com"
serverPort = 7000

[[proxies]]
name = "t3"
type = "http"
localIP = "127.0.0.1"
localPort = 3773
customDomains = ["home.workers.example.com"]
```

Use your FRP server's normal authentication settings in that same TOML; do not put its token in a CLI flag.

## Lifecycle

```sh
bunx @bioshazard/t3-worker start
bunx @bioshazard/t3-worker stop
bunx @bioshazard/t3-worker restart
bunx @bioshazard/t3-worker status
bunx @bioshazard/t3-worker logs
```

Publish the package to npm for the `bunx @bioshazard/t3-worker` form. Until publication, use Bun's GitHub package form from this repository and pin a commit for reproducibility.

## Commands

```sh
bun install
bun run check
bun test
bun run build
bun run dev
bun run contract:inventory
bun run contract:matrix
bun run contract:capture -- artifacts/raw/<corpus>.jsonl
bun run contract:record
bun run contract:scenarios
bun run contract:reference
bun run contract:reference-verify -- artifacts/runs/<corpus>.reference.json
```

The POC is intentionally explicit about unsupported requests. It does not run OpenCode and does not claim complete OpenCode compatibility.
