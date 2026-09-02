# T3 Fauxpencode

See [`docs/poc.md`](docs/poc.md) for the provisional facade surface and known capture gaps. See [`docs/runbook.md`](docs/runbook.md) for capture, scenario, and verification commands.

Single-machine Bun launcher for an isolated T3 worker backed by Pi sessions. It exposes the OpenCode-shaped surface T3 needs; PM2 and optional FRP are implementation details.

## Run

Run it from the project directory T3 will use. The current directory is the one permitted session root; there are no repo or worker-name flags.

```sh
bunx t3-fauxpencode start
```

The launcher stores its singleton state under `~/.local/share/t3-fauxpencode/` (override only for testing with `T3_WORKER_HOME`). It starts PM2-managed shim and T3 processes. The T3 settings are isolated from a normal T3 installation.

## FRP

Pass a complete client configuration on the first start:

```sh
bunx t3-fauxpencode start --frpc-config ~/frpc.toml
```

The config is copied to the worker state directory and enables a third PM2 process. On its first use, the launcher downloads the matching official `frpc` binary for macOS/Linux `amd64` or `arm64`.

FRP must target T3, not the shim. Create a token file with the token configured on your FRP server, then protect it:

```sh
mkdir -p ~/.config/t3-fauxpencode
printf '%s' '<frp-token>' > ~/.config/t3-fauxpencode/frp-token
chmod 600 ~/.config/t3-fauxpencode/frp-token
```

Create `~/frpc.toml`:

```toml
serverAddr = "frp.example.com"
serverPort = 7000

auth.method = "token"
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "/Users/you/.config/t3-fauxpencode/frp-token"

[[proxies]]
name = "t3"
type = "http"
localIP = "127.0.0.1"
localPort = 3773
customDomains = ["home.workers.example.com"]
```

Replace the server address, token-file path, and public hostname. Point that hostname's DNS record at the FRP server. The FRP server must have HTTP virtual-host support enabled (its `vhostHTTPPort`), and must use the same token authentication. Terminate TLS at the FRP server or its edge proxy: hosted T3 needs the public endpoint over HTTPS/WSS. Then start the worker:

```sh
bunx t3-fauxpencode start --frpc-config ~/frpc.toml
```

The launcher copies the TOML to its state directory, downloads the matching `frpc` binary if needed, and starts it under PM2. The token file remains where the TOML points; do not put its token in a CLI flag.

## Lifecycle

```sh
bunx t3-fauxpencode start
bunx t3-fauxpencode stop
bunx t3-fauxpencode restart
bunx t3-fauxpencode status
bunx t3-fauxpencode logs
```

Publish the package to npm for the `bunx t3-fauxpencode` form. The release workflow in [publish.yml](.github/workflows/publish.yml) uses npm trusted publishing after its one-time setup.

### npm publishing

Publish version `0.1.0` once from a trusted local machine, then configure npm to trust this repository's release workflow:

```sh
npm publish
npm trust github t3-fauxpencode \
  --repo <owner>/<repo> \
  --file publish.yml \
  --env npm \
  --allow-publish
```

Create an `npm` GitHub environment for the repository, then publish future versions by creating a GitHub Release after updating `package.json`'s version. The workflow uses OIDC; it needs no `NPM_TOKEN` secret.

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
