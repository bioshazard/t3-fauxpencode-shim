# Capture and verification runbook

The repository has independent inventory, recorder, scenario, capture-validation, and reference-supervisor tools. The inventory and matrix are committed evidence; raw runs are written under ignored `artifacts/` paths.

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
CONTRACT_RUN_ID=<run-id> \
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
CONTRACT_RUN_ID=<run-id> \
SCENARIO_OUTPUT=artifacts/runs/<corpus>.json \
SCENARIO_BARRIER_URL=http://127.0.0.1:<barrier-port> \
bun run contract:scenarios
```

The local driver exercises C01-C06 (C04 list/get/missing lookup; C05 empty and populated history), C11 abort, C13-C14 rollback/continue, C17 scoped concurrency, and C18 malformed/unknown requests. C11 requires a supplied active-turn barrier; without it the report is deliberately `partial`. A `partial` report is never a passing contract.

## Run the pinned reference gate

The reference gate must be driven by stock T3's OpenCode adapter. The supervisor accepts argv as JSON arrays (no shell parsing), starts the pinned OpenCode command, places the recorder in front of it, and passes the recorder URL to the T3 command:

```sh
CORPUS_ID=<manifest-corpus-id> \
REFERENCE_T3_KIND=stock-t3-opencode-adapter \
T3_REFERENCE_ROOT=/path/to/pinned/t3code \
OPENCODE_REFERENCE_ROOT=/path/to/pinned/opencode \
OPENCODE_REFERENCE_BIN=./node_modules/.bin/opencode \
REFERENCE_OPENCODE_ARGV='["%OPENCODE_BIN%","serve","--hostname=127.0.0.1","--port=%PORT%"]' \
REFERENCE_T3_ARGV='["pnpm","test:opencode-adapter"]' \
REFERENCE_NODE_VERSION='v24.13.1' \
REFERENCE_PACKAGE_MANAGER='pnpm@11.10.0' \
REFERENCE_MODEL_PROVIDER=<provider> \
REFERENCE_MODEL=<model> \
REFERENCE_MODEL_FIXTURE=<deterministic-fixture> \
bun run contract:reference
```

The supervisor verifies both checkout HEADs against `contracts/manifest.json`, runs OpenCode from its pinned checkout, and passes the recorder URL as `OPENCODE_BASE_URL` to T3. `REFERENCE_T3_ARGV` must invoke the unmodified pinned T3 provider path; the supervisor rejects missing commands and does not substitute the raw-fetch scenario driver. The T3 harness must propagate `CONTRACT_RUN_ID` and `x-contract-scenario` through its test transport, and must write the scenario report at `SCENARIO_OUTPUT`. A successful run validates the capture JSONL and requires every scenario report entry to pass before writing a reference-run manifest. The command fails if either checkout is not pinned, OpenCode never becomes healthy, T3 exits non-zero, the scenario report is partial, or capture validation fails.

The runtime/model variables are required for a passing manifest and are recorded with source package provenance. `REFERENCE_NODE_VERSION` must describe the Node runtime used by the T3 harness; `REFERENCE_PACKAGE_MANAGER` includes its exact version. `REFERENCE_MODEL_FIXTURE` names the deterministic barrier/fixture configuration used by the run.

Verify a completed corpus independently after the supervisor exits:

```sh
bun run contract:reference-verify -- artifacts/runs/<corpus>.reference.json
```

Verification checks the recorded T3/OpenCode commits, capture and scenario-report SHA-256 digests, capture correlation, and complete passed scenario set.

Run the shim acceptance gate against a running `pi-opencode-server` (the same headless scenarios, without OpenCode):

```sh
SHIM_ACCEPTANCE_TARGET=http://127.0.0.1:4096 \
SHIM_ACCEPTANCE_OUTPUT=artifacts/runs/shim-acceptance.json \
SCENARIO_BARRIER_URL=http://127.0.0.1:<barrier-port> \
bun run contract:acceptance
```

The gate rejects partial or failed scenarios. If `contracts/matrix.json` is frozen, it first verifies the referenced reference manifest and corpus identity.

## Maintain evidence

1. Update `contracts/manifest.json` for a new upstream identity; never overwrite a corpus with a different identity.
2. Update `contracts/inventory.json` from pinned source and run `bun run contract:inventory`.
3. Keep raw captures in ignored `artifacts/raw/`; redact before moving any fixture into version control.
4. Populate `contracts/matrix.json` only from raw evidence and T3 canonical observations; never promote local shim output to reference evidence.
5. Run `bun run contract:matrix` and the full test suite before committing.

The matrix remains `pending-reference-capture` until every required row has reproducible evidence and no implementation-blocking unknowns.
