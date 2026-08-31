# Contract-Capture and Compatibility Specification

## 1. Purpose

This document specifies the work required to discover, record, and later implement the OpenCode contract that stock T3 Code actually uses.

The contract has two gates:

- **Reference gate:** repeatable evidence from pinned T3 Code talking to pinned real OpenCode.
- **Shim gate:** the same T3 scenarios pass against `pi-opencode-server`, backed by `@earendil-works/pi-coding-agent`, with equivalent normalized observations.

Endpoint lists in upstream docs are discovery inputs, not the contract. Runtime observations plus T3's resulting canonical thread state are the contract.

## 2. Normative language

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` are normative. Unresolved items are marked `TBD` and MUST be resolved by capture before shim behavior depending on them is implemented.

## 3. Pinned test subjects

Every capture corpus MUST record:

| Subject | Required identity |
| --- | --- |
| T3 Code | repository URL, commit SHA, package versions, runtime command |
| OpenCode | repository/package source, exact version or commit SHA, server command |
| Pi | `@earendil-works/pi-coding-agent` exact version and Pi repository commit if known |
| Runtime | OS/architecture, Node and package-manager versions |
| Model | provider/model identity and deterministic-test configuration |

The repository MUST contain a machine-readable version manifest. A capture from different identities is a new corpus, never an in-place overwrite.

## 4. Vocabulary and identity map

| Concept | T3 | OpenCode facade | Pi |
| --- | --- | --- | --- |
| Conversation | thread | session | persistent session/JSONL |
| Invocation | turn | prompt/message operation | `AgentSession.prompt()` run |
| Cancellation | interrupt | session abort | `AgentSession.abort()` |
| History change | rollback | revert/unrevert or observed equivalent | tree navigation/branch mapping, TBD |

The shim MUST maintain stable mappings for T3 thread ID, T3 turn ID, OpenCode session ID, Pi session ID, Pi session file, and relevant message/part/tool-call IDs. Mapping ownership and persistence format are implementation decisions, but restart behavior MUST preserve all externally visible IDs needed by T3.

## 5. Discovery phase

Before dynamic capture, the implementer MUST produce a static inventory from the pinned T3 revision:

1. locate the OpenCode adapter, provider service, runtime launcher, SDK/client construction, and integration tests;
2. list every OpenCode SDK method or raw path reachable from the acceptance scenarios;
3. identify how server URL, process ownership, working directory, environment, and lifecycle are injected;
4. identify the SSE consumer and every event discriminator/field it reads;
5. identify how T3 reconstructs canonical thread state and decides a turn is complete, aborted, failed, or rolled back; and
6. identify provider logs/traces used for diagnosis.

Output: `contracts/inventory.json` and a short generated Markdown view. Each inventory entry MUST cite file and line or symbol in the pinned T3 tree.

If pinned T3 cannot target an external server, use the narrowest test-only seam already present. If none exists, add transport/process injection only in the external test harness or vendored test checkout. The intended deployed system MUST use unmodified T3.

## 6. Capture topology

The reference run MUST exercise the real T3 `OpenCodeAdapter` or the narrowest provider layer containing all production transformations.

```text
scenario driver
  -> stock T3 provider path
  -> recording boundary
  -> real OpenCode server
  -> deterministic/cheap model
```

The recording boundary MAY be an HTTP reverse proxy, instrumented SDK transport, or both. It MUST NOT change request bodies, response bodies, stream framing, status codes, or ordering.

Capture at three layers:

1. **Wire:** HTTP request/response and raw SSE frames.
2. **Parsed provider:** OpenCode events as received by T3's adapter.
3. **Canonical result:** T3 provider events and reconstructed thread/session state.

T3's trace and raw/canonical provider logs SHOULD be retained with each run.

## 7. Required scenario suite

Each scenario MUST start from declared state and record its expected terminal condition.

| ID | Scenario | Required observation |
| --- | --- | --- |
| C01 | Startup and health | readiness probe, response shape, retry/timing behavior |
| C02 | Provider/model discovery | all calls and exact fields T3 reads |
| C03 | Create session | directory/cwd handling, IDs, defaults, initial status |
| C04 | Get/list/resume session | lookup behavior and missing-session behavior |
| C05 | Read empty and populated history | message/part shapes and ordering |
| C06 | Simple streamed text turn | request, deltas, completion signal, final history |
| C07 | Reasoning plus text, if model emits it | visibility, deltas, final part representation |
| C08 | Successful tool call | tool start/input deltas/completion/result and ordering |
| C09 | Failed tool call | error representation and whether the turn continues |
| C10 | Model/provider failure | HTTP/SSE/provider error mapping and terminal state |
| C11 | Abort during streamed text | abort call, stream termination, status, retained history |
| C12 | Abort during tool execution | cancellation boundary and retained tool/message state |
| C13 | Roll back/revert completed turn | target identifier, returned state, emitted events, history |
| C14 | Continue after rollback | branch semantics and identifier stability |
| C15 | T3 reconnect/read reconstruction | state rebuilt without relying on lost live events |
| C16 | Server restart/session resume | behavior required from the future Pi-backed shim |
| C17 | Two concurrent sessions | isolation, interleaving, event scoping |
| C18 | Unknown session and malformed request | status/error body and T3 reaction |
| C19 | Graceful and unexpected server exit | adapter error and recoverability behavior |

Permissions, questions, sharing, file APIs, session children, compaction, and other features MUST be added only if static inventory or runtime capture shows T3 uses them in the supported workflow.

For timing-sensitive scenarios, the model/tool fixture MUST provide barriers so the test controls when abort, reconnect, or concurrency transitions happen. Wall-clock sleeps alone are insufficient.

## 8. Wire capture record

Every HTTP exchange MUST retain:

- scenario/run ID and monotonic sequence number;
- method, raw path, query parameters, and request body;
- semantically relevant headers, including content type and SSE negotiation;
- response status, headers, and body;
- connection open/close/error state;
- monotonic timestamps for ordering and durations; and
- correlation to T3 thread, turn, and OpenCode session when knowable.

Every SSE stream MUST additionally retain:

- exact raw frames, including `event`, `data`, `id`, `retry`, comments, and blank-line boundaries;
- parsed JSON without discarding unknown fields;
- connection/reconnection number;
- global versus directory/session scoping;
- ordering relative to HTTP responses; and
- normal close, client cancellation, server close, or transport error.

Secrets, authorization values, user-home prefixes, and unrelated environment values MUST be redacted before artifacts can be committed. Redaction MUST preserve equality relationships through stable placeholders.

## 9. Contract matrix schema

The authoritative matrix MUST be machine-readable JSON or YAML. Its schema MUST support at least:

```yaml
id: OC-T3-0001
scenario: C06
operation: session.prompt
trigger: T3 adapter action or preceding event
request:
  method: POST
  path: TBD
  query: {}
  headers: {}
  body: {}
response:
  status: TBD
  headers: {}
  body: {}
events:
  - stream: global-or-scoped
    type: TBD
    required_fields: {}
    order_after: []
state_effect:
  opencode: TBD
  t3: TBD
error_behavior: TBD
normalization: []
evidence:
  - raw capture reference
  - T3 source symbol reference
confidence: observed
support: required
notes: ""
```

Allowed confidence values:

- `observed`: seen in a reproducible runtime capture;
- `source-confirmed`: required by pinned T3 source but not yet produced dynamically;
- `hypothesis`: proposed mapping, never sufficient for implementation acceptance.

Allowed support values:

- `required`: needed by supported scenarios;
- `conditional`: needed only when a recorded condition occurs;
- `excluded`: deliberately unsupported, with evidence that stock T3 does not require it.

Each required row MUST contain raw evidence, normalized expected behavior, and a T3 consumer/source reference. No `TBD` may remain in a row used to judge the shim.

## 10. Normalization and equivalence

Raw captures are immutable evidence. Normalized fixtures MAY replace only nondeterministic values:

- IDs with typed stable placeholders;
- absolute temporary/workspace/home paths;
- timestamps and durations;
- ports and process IDs;
- provider-generated prose when semantic content is not under test;
- token counts or cost fields proven nondeterministic.

Normalization MUST NOT erase:

- identifier equality or parent/child relationships;
- array and event ordering;
- omitted versus `null` fields;
- incremental versus final content boundaries when T3 observes them;
- status transitions;
- tool-call linkage;
- abort/revert boundaries; or
- error class and recoverability semantics.

Comparison SHOULD distinguish:

- **exact:** wire value/framing must match;
- **structural:** schema and relationships must match;
- **semantic:** T3's canonical resulting state must match;
- **ignored:** proven unobserved nondeterminism.

Every ignored field requires a documented reason.

## 11. Pi-side mapping hypotheses

These guide later implementation but are not accepted until the matrix is complete:

- Create or reopen sessions with `createAgentSession()` and a persistent `SessionManager`.
- Keep one active `AgentSession` per OpenCode session; serialize prompts within it.
- Use `session.subscribe()` for streaming message/turn/tool translation.
- Use `session.prompt()` for a normal turn and `session.abort()` for cancellation.
- Use Pi's normal agent directory, `ModelRuntime`, settings, and resource loader defaults unless capture requires a facade override.
- Reconstruct history from Pi session entries/messages rather than an independent transcript.
- Investigate `navigateTree()` for revert semantics; do not equate it with OpenCode revert until target selection, emitted events, persistence, and continuation behavior match.
- Call `dispose()` only when releasing an active runtime; persisted session data must remain reopenable.

The shim MAY persist a small sidecar index for facade IDs and relationships Pi does not store. It MUST use atomic updates and MUST be reconstructable or explicitly migratable.

## 12. Test and artifact layout

The implementation model SHOULD create this logical structure:

```text
docs/
  scope.md
  contract.md
contracts/
  manifest.json
  matrix.json
  inventory.schema.json
  matrix.schema.json
  capture.schema.json
fixtures/
  raw/<corpus>/<scenario>/
  normalized/<corpus>/<scenario>/
scripts-or-tests/
  capture-reference
  normalize-capture
  verify-matrix
  run-shim-acceptance
```

Exact test framework and filenames are implementation choices. Committed commands MUST be noninteractive, fail on mismatch, and print artifact locations.

Large, sensitive, or machine-specific raw captures MAY remain uncommitted, but the manifest, checksums, redaction report, normalized fixtures, and reproduction command MUST be committed.

## 13. Acceptance workflow

1. Pin upstreams and runtime.
2. Produce static inventory.
3. Run all applicable reference scenarios against real OpenCode.
4. Redact and normalize without deleting raw evidence.
5. Populate and schema-validate the contract matrix.
6. Review every required row; resolve all `TBD`s.
7. Freeze the reference corpus by checksum.
8. Implement the minimum shim surface.
9. Run identical scenarios against the shim.
10. Compare wire/structural behavior and T3 canonical state according to each matrix row.
11. Run restart/resume and concurrency tests against Pi persistence.
12. Perform one browser smoke test.

When a shim run causes T3 to make a previously unseen request or consume a previously unseen event, acceptance MUST fail with an unclassified-contract error rather than silently tolerating it.

## 14. Completion criteria for the contract-capture phase

The contract is ready for implementation only when:

- upstream identities and reproduction commands are pinned;
- the static inventory covers every reachable OpenCode interaction in the scenarios;
- every applicable scenario has a reproducible raw capture;
- normalized fixtures validate against their schema;
- every required matrix row is `observed` or explicitly `source-confirmed` with a planned dynamic fixture;
- no implementation-blocking `TBD` remains;
- event ordering and completion rules are explicit;
- abort and rollback retained-state semantics are explicit;
- a reviewer can trace each matrix claim to raw evidence and a T3 consumer; and
- the suite can be rerun headlessly without a browser.

## 15. Implementation work packages

| Package | Work | Exit artifact |
| --- | --- | --- |
| W1 | Pin upstreams; map T3 call sites, event consumers, lifecycle, and injection seams | manifest and static inventory |
| W2 | Build transparent HTTP/SSE recording plus T3 canonical-state capture | capture harness and schemas |
| W3 | Build deterministic scenario driver and execute C01–C19 as applicable | raw reference corpus |
| W4 | Redact, normalize, classify, and review observations | frozen normalized fixtures and matrix |
| W5 | Implement only required matrix rows over Pi SDK | `pi-opencode-server` and translation tests |
| W6 | Replay scenarios against shim; test restart and concurrency | headless acceptance report |
| W7 | Run stock T3 browser smoke after headless pass | smoke-test record and runbook |

W1–W4 are the contract-capture milestone. W5 MUST NOT invent behavior for unresolved required rows. Work packages SHOULD be separate commits so evidence capture remains reviewable independently from emulation code.

## 16. Current API evidence, not yet contract

Current upstream documentation indicates likely calls including global health, global or scoped SSE events, session status, session/message operations, abort, and revert/unrevert. Current Pi documentation exposes `createAgentSession()`, persistent `SessionManager` use, `AgentSession.subscribe()`, `prompt()`, `abort()`, `navigateTree()`, and `dispose()`.

These facts establish feasibility. They MUST NOT be copied into the compatibility matrix as required wire behavior until the pinned T3 reference run observes or source-confirms them.

Starting primary references:

- [Pi coding-agent SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi coding-agent sessions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md)
- [Pi `AgentSession` implementation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts)
- [OpenCode OpenAPI specification](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/openapi.json)
- [T3 OpenCode adapter](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Layers/OpenCodeAdapter.ts)
- [T3 OpenCode runtime](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/opencodeRuntime.ts)
