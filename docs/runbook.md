# Capture and verification runbook

The repository has three independent capture tools. The inventory and matrix are committed evidence; raw runs are written under ignored `artifacts/` paths.

## Local checks

```sh
bun install
bun run check
bun test
```

## Start the provisional shim

```sh
PI_SESSION_DIR="$PWD/artifacts/pi-sessions" bun run dev
```

The service listens on `127.0.0.1:4096` unless `PI_OPENCODE_HOST` or `PI_OPENCODE_PORT` is set.

## Record a reference server

Run the recorder in front of the pinned real OpenCode server used by the reference corpus:

```sh
CAPTURE_TARGET=http://127.0.0.1:<opencode-port> \
CAPTURE_OUTPUT=artifacts/raw/<corpus>.jsonl \
bun run contract:record
```

The proxy preserves method, path, query, status, headers, body text, SSE framing as delivered by `fetch`, connection errors, sequence numbers, and timing. Authorization/cookie headers, home-directory prefixes, and common bearer/key forms are replaced with stable placeholders. Bodies are capped at 8 MiB by default; set `CAPTURE_MAX_BODY_BYTES` when a larger fixture is required.

Validate a raw capture before using it as evidence:

```sh
bun run contract:capture -- artifacts/raw/<corpus>.jsonl
```

Validation fails on malformed records, non-monotonic sequences, incomplete structured SSE fields, missing close metadata, or obvious unredacted credentials.

## Drive headless scenarios

Point the scenario driver at the recorder URL so the same requests are captured:

```sh
SCENARIO_TARGET=http://127.0.0.1:<proxy-port> \
CORPUS_ID=<manifest-corpus-id> \
SCENARIO_OUTPUT=artifacts/runs/<corpus>.json \
bun run contract:scenarios
```

The current driver exercises C01-C06 (with C05 history), C11 abort, C13-C14 rollback/continue, C17 concurrency, and C18 malformed/unknown requests. A `partial` report means setup or terminal SSE evidence was unavailable; it is not a passing contract.

## Maintain evidence

1. Update `contracts/manifest.json` for a new upstream identity; never overwrite a corpus with a different identity.
2. Update `contracts/inventory.json` from pinned source and run `bun run contract:inventory`.
3. Keep raw captures in ignored `artifacts/raw/`; redact before moving any fixture into version control.
4. Populate `contracts/matrix.json` only from raw evidence and T3 canonical observations.
5. Run `bun run contract:matrix` and the full test suite before committing.

The matrix remains `pending-reference-capture` until every required row has reproducible evidence and no implementation-blocking unknowns.
