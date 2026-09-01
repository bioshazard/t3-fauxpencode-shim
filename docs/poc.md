# POC surface

This is a provisional, Bun-native facade. It is not the captured T3 contract yet; the paths and event names remain subject to the reference-capture phase in [`contract.md`](contract.md).

| Operation | Route | Result |
| --- | --- | --- |
| Health | `GET /global/health` | JSON readiness response |
| Provider discovery | `GET /provider` | Pi provider and configured model presentation |
| Optional discovery | `GET /agent`, `GET /skill` | Empty lists until Pi resource discovery is captured |
| Global events | `GET /event` or `GET /global/event` | SSE stream |
| Scoped events | `GET /session/:id/event` | Session-filtered SSE stream |
| Create | `POST /session` | Persistent Pi-backed session |
| Lookup/list | `GET /session`, `GET /session/:id` | OpenCode session metadata projected from Pi |
| Session update | `PATCH /session/:id` | Permission policy update, retained in the active session |
| History | `GET /session/:id/message`, `GET /session/:id/message/:messageId` | `{info, parts}` entries or one matching entry projected from Pi |
| Prompt | `POST /session/:id/message` or `/prompt` | Pi turn plus SSE lifecycle; text and data-URL image parts are accepted |
| Async prompt | `POST /session/:id/prompt_async` | Accepted turn plus SSE lifecycle |
| Session status | `GET /session/status` | Session ID to idle/busy status map |
| Abort | `POST /session/:id/abort` | Boolean acknowledgement (facade behavior; compatibility semantics pending reference capture) |
| Revert | `POST /session/:id/revert` | Updated session after tree navigation (mapping remains provisional until reference capture) |

The deployed entrypoint uses `PiSessionBackend`; tests use an injectable, deterministic backend to exercise tool ordering, aborts, rollback, permissions, image projection, and concurrent-session isolation without requiring a model call. These are facade behaviors, not captured compatibility claims: `contracts/matrix.json` remains `pending-reference-capture` until the pinned reference gate produces evidence.

## Session directory tracking (shim extension)

Real OpenCode runs inside the project, so its server cwd is the project directory and T3 sends `POST /session` without a `cwd` field. This shim is launched from a fixed location, so it extends the contract: it tracks the `directory` query parameter on the selected project's `GET /event` stream and uses the most recently seen allowed project directory when `POST /session` omits `cwd`. Sightings expire after 30 seconds. Without a recent allowed project signal, a cwd-less request fails with `409 cwd_required`; it never falls back to `PI_CWD`. Tracked directories pass the same `PI_ALLOWED_ROOTS` gate as explicit cwds; out-of-root signals are ignored. An explicit `cwd` in the request body always wins.

Configuration:

- `PI_AGENT_DIR`: Pi config/resources directory.
- `PI_SESSION_DIR`: optional shared Pi JSONL session directory.
- `PI_CWD`: shim working directory for Pi resource discovery; it is not a session-creation fallback.
- `PI_ALLOWED_ROOTS`: JSON array of allowed session roots (or `{"roots":[...]}`); defaults to `PI_CWD`. Set this in the launch environment; the PM2 ecosystem file passes it through unchanged.

For the local PM2 stack, export `PI_ALLOWED_ROOTS` before starting or restarting it, then run `bunx pm2@7.0.4 restart pi-opencode-shim --update-env`. With no environment value, PM2 permits only the shim checkout, discovered from `ecosystem.config.cjs`. Every added workspace root must already exist; sessions outside this allow list are rejected.

- `PI_OPENCODE_HOST` / `PI_OPENCODE_PORT`: listener address.
- `PI_PROVIDER` / `PI_MODEL`: provider discovery presentation values; Pi still resolves runtime model/auth through its native configuration.

Runtime request logging is emitted as JSON Lines to stdout. Each completed request records its method, path, query, safe headers, status, and duration. JSON request shapes are captured with prompt/image content and sensitive values redacted; samples cap at 16 KiB. This is intended for locally observing new T3 requests without leaking credentials or prompt contents.

## T3 web fixture

Start the shim, then launch T3 with an isolated shim-only state directory:

```sh
PI_OPENCODE_URL=http://127.0.0.1:41874 bun run t3:shim
```

The command writes `artifacts/t3-shim-home/userdata/settings.json`, disables Codex and Claude, enables OpenCode, and sets T3 text generation to `pi/configured`. It starts the published `t3@0.0.37` CLI by default. Set `T3_ROOT` to use a source checkout for debugging, `T3_VERSION` for another exact release, or `T3_HOME` for another disposable state directory. The settings file is deliberately rewritten on every launch.

To keep local services detached from the terminal, run:

```sh
bun run dev:local
```

Then use `bun run logs:local` and `bun run stop:local`. PM2 runs both the shim and T3; it does not enable watch mode, because T3 already manages its own development processes when `T3_ROOT` is used.
