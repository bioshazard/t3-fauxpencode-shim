# Pi–OpenCode Shim: Scope

## Objective

Build `pi-opencode-server`, a local Node service that lets stock T3 Code use Pi through T3's existing OpenCode provider path.

```text
T3 Web -> T3 server -> OpenCode HTTP/SSE facade -> Pi coding-agent SDK -> configured model
```

OpenCode itself must not run in the final system.

## Product boundary

The shim owns only the compatibility boundary between:

- the exact OpenCode behavior exercised by a pinned T3 Code revision; and
- `@earendil-works/pi-coding-agent` session/runtime behavior.

It is not a general OpenCode reimplementation. Observed T3 behavior, not the complete OpenCode API, defines the required surface.

## In scope

- A headless contract-capture harness against stock T3 Code and real OpenCode.
- A versioned, reproducible captured contract matrix covering HTTP, SSE, ordering, state transitions, and failures.
- The smallest OpenCode-compatible HTTP/SSE service satisfying that matrix.
- One persistent Pi session per T3/OpenCode session.
- In-memory ownership of active Pi sessions and lazy reopening from Pi JSONL storage.
- Pi-native configuration and resources: agent directory, `models.json`, settings, skills, extensions, prompts, `AGENTS.md`, compaction, and model selection.
- Translation of Pi messages, turns, tool calls/results, usage, errors, and lifecycle events into the OpenCode representations T3 consumes.
- Session creation, lookup/history, prompt, abort, and rollback/revert behavior proven to be required by capture.
- Concurrent independent T3 threads.
- Contract, adapter-integration, restart/resume, and final browser smoke tests.
- Diagnostics sufficient to correlate one T3 thread/turn with OpenCode facade traffic and its Pi session/turn.

## Out of scope

- Running or embedding OpenCode in production.
- Full compatibility with arbitrary OpenCode clients.
- OpenCode features T3 does not exercise in the pinned acceptance scenarios.
- Replacing Pi's configuration, resource loading, extension system, session format, or model runtime.
- `pi-agent-core` as the application integration layer.
- `pi-remote`, `pi-client`, or a separate Pi process for the initial implementation.
- Modifying T3 Web or maintaining a T3 fork as the intended solution.
- Multi-host operation, authentication, TLS termination, public exposure, or multi-user isolation.
- Exact visual parity before the headless acceptance gate passes.

## Compatibility principles

1. Capture before emulation. Do not infer wire behavior solely from OpenAPI types or source.
2. Pin all three upstream revisions: T3 Code, OpenCode, and Pi.
3. Preserve both raw evidence and normalized fixtures.
4. Match externally observable semantics, including event order, identifiers, status transitions, abort boundaries, and rollback results.
5. Keep Pi authoritative below the facade. Compatibility metadata may supplement Pi state but must not replace its session history.
6. Keep the supported surface explicit. A newly observed T3 call fails a contract test until classified and implemented.
7. Treat T3's stock `OpenCodeAdapter` as the primary acceptance client.

## Deliverables

- `docs/contract.md`: capture and compatibility contract.
- Pinned upstream/version manifest.
- Headless reference-capture harness.
- Raw capture corpus and deterministic normalized fixtures.
- Machine-readable contract matrix with human-readable generated view.
- `pi-opencode-server` implementation.
- Unit tests for Pi/OpenCode translation.
- Official OpenCode SDK contract tests where useful.
- Stock T3 OpenCode adapter integration tests.
- Restart/resume and two-thread concurrency tests.
- Runbook for development, capture refresh, debugging, and final smoke testing.

## Acceptance boundary

The initial project is complete when, without OpenCode running, a pinned unmodified T3 server can use its stock OpenCode provider path to:

1. discover the facade and available model information;
2. create a thread-backed session;
3. run a text turn and reconstruct the same canonical thread state as the reference capture;
4. represent at least one successful tool call and result;
5. abort an active turn without corrupting the session;
6. roll back/revert a completed turn and continue from the resulting state;
7. restart the shim, reopen the Pi session, and continue;
8. run two independent active sessions without event or state leakage; and
9. pass the captured contract matrix and T3 adapter acceptance suite.

One final browser smoke test confirms the already-proven headless path.

## Constraints and open decisions

- Exact paths, payloads, SSE event names, and required headers remain unknown until captured.
- The pinned T3 revision may spawn and own OpenCode rather than accept an external URL. Contract discovery must locate the supported injection seam; test-only transport injection is acceptable, production T3 changes are not.
- OpenCode API generations differ. The capture, not a generic OpenCode document, selects the target dialect.
- Pi tree navigation and OpenCode revert may not be semantically identical. The implementation must define a durable mapping only after both behaviors are measured.
- Model/provider presentation may require facade-only identifiers while Pi retains actual provider/model authority.
