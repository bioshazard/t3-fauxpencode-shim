# Pi–OpenCode Shim POC

See [`docs/poc.md`](docs/poc.md) for the provisional facade surface and known capture gaps. See [`docs/runbook.md`](docs/runbook.md) for capture, scenario, and verification commands.

Small Bun service exposing the OpenCode-shaped surface needed by the documented T3 integration, backed by Pi sessions.

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
```

The POC is intentionally explicit about unsupported requests. It does not run OpenCode and does not claim complete OpenCode compatibility.
