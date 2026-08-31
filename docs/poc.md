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
| History | `GET /session/:id/message` | `{info, parts}` entries projected from Pi |
| Prompt | `POST /session/:id/message` or `/prompt` | Pi turn plus SSE lifecycle |
| Async prompt | `POST /session/:id/prompt_async` | Accepted turn plus SSE lifecycle |
| Session status | `GET /session/status` | Session ID to idle/busy status map |
| Abort | `POST /session/:id/abort` | OpenCode-compatible boolean acknowledgement |
| Revert | `POST /session/:id/revert` | Updated session after tree navigation |

The deployed entrypoint uses `PiSessionBackend`; tests use an injectable, deterministic backend to exercise tool ordering, aborts, rollback, and concurrent-session isolation without requiring a model call.

Configuration:

- `PI_AGENT_DIR`: Pi config/resources directory.
- `PI_SESSION_DIR`: optional shared Pi JSONL session directory.
- `PI_CWD`: default session working directory.
- `PI_OPENCODE_HOST` / `PI_OPENCODE_PORT`: listener address.
- `PI_PROVIDER` / `PI_MODEL`: provider discovery presentation values; Pi still resolves runtime model/auth through its native configuration.
