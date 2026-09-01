# Pi–OpenCode Shim POC

See [`docs/poc.md`](docs/poc.md) for the provisional facade surface and known capture gaps. See [`docs/runbook.md`](docs/runbook.md) for capture, scenario, and verification commands.

Small Bun service exposing the OpenCode-shaped surface needed by the documented T3 integration, backed by Pi sessions.

## Run

Run it in the project directory T3 will use. By default, only that directory is permitted for sessions:

```sh
bunx --bun --package github:bioshazard/t3-fauxpencode-shim pi-opencode-shim
```

To permit project trees other than the launch directory, provide a comma-separated list through `PI_ALLOWED_ROOTS`. Keep this narrow: every child directory is exposed to Pi sessions.

```sh
PI_CWD=/path/to/project \
PI_ALLOWED_ROOTS=/path/to/project,/path/to/another-project \
bunx --bun --package github:bioshazard/t3-fauxpencode-shim pi-opencode-shim
```

Append `--with-t3` to start an isolated local T3 worker with shim settings already applied. Its state lives at `$TMPDIR/pi-opencode-shim-t3-home`; use `--t3-home <directory>` to choose another location.

The GitHub form needs no CI build: Bun installs the repository and executes the TypeScript CLI. For a stable public interface, publish the same package to npm (after removing `private: true`) and users can instead run `bunx pi-opencode-shim`. Pin a Git commit or npm version for reproducible use.

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
