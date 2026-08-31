import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadMatrix, pathMatches, validateMatrix } from "./matrix.ts";
import {
  decodeScenarioReport,
  isRecordValue,
  isStringValue,
  REQUIRED_REFERENCE_SCENARIOS,
} from "./reference-artifacts.ts";
import { verifyReferenceArtifacts } from "./reference-verify.ts";
import type { ScenarioReport } from "./scenarios.ts";

type ComparableReport = {
  readonly corpusId: string | null;
  readonly scenarios: readonly ComparableScenario[];
  readonly status: "completed" | "partial";
};

type ComparableScenario = {
  readonly applicability: "required" | "not-applicable";
  readonly canonicalState: unknown;
  readonly id: string;
  readonly operations: readonly {
    readonly body: string | null;
    readonly method: string;
    readonly path: string;
    readonly status: number | null;
  }[];
  readonly observedEventTypes: readonly string[];
};

export interface AcceptanceHarnessConfig {
  readonly barrierUrl: string | undefined;
  readonly corpusId: string;
  readonly runId: string;
  readonly scenarioOutput: string;
  readonly target: string;
  readonly timeoutMs: number;
}

export interface AcceptanceProcessConfig extends AcceptanceHarnessConfig {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type AcceptanceProcessRunner = (
  config: AcceptanceProcessConfig
) => Promise<number>;

export type AcceptanceGitInspector = (
  cwd: string
) => Promise<{ readonly head: string; readonly status: string }>;

export interface AcceptanceOptions {
  readonly gitInspector?: AcceptanceGitInspector;
  readonly processRunner?: AcceptanceProcessRunner;
}

type MatrixRecord = { readonly [key: string]: unknown };

function readArgv(name: string): readonly string[] {
  const raw = Bun.env[name];
  if (raw === undefined || raw.trim().length === 0)
    throw new Error(`${name} must be a JSON array of argv strings.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must contain valid JSON.`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(isStringValue) ||
    parsed.some((part) => part.trim().length === 0)
  )
    throw new Error(`${name} must be a non-empty JSON array of argv strings.`);
  return parsed;
}

async function runConfiguredHarness(
  config: AcceptanceHarnessConfig,
  argv: readonly string[],
  cwd: string,
  processRunner: AcceptanceProcessRunner
): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CAPTURE_TARGET: config.target,
    CONTRACT_RUN_ID: config.runId,
    CORPUS_ID: config.corpusId,
    OPENCODE_BASE_URL: config.target,
    SCENARIO_OUTPUT: config.scenarioOutput,
    SCENARIO_TARGET: config.target,
    SHIM_ACCEPTANCE_TARGET: config.target,
    SCENARIO_BARRIER_URL: config.barrierUrl,
  };
  const exitCode = await processRunner({ ...config, argv, cwd, env });
  if (exitCode !== 0)
    throw new Error(
      `Stock T3 shim acceptance command exited with ${exitCode}.`
    );
}

const defaultProcessRunner: AcceptanceProcessRunner = async (config) => {
  const child = Bun.spawn({
    cmd: [...config.argv],
    cwd: config.cwd,
    env: config.env,
    stderr: "inherit",
    stdout: "inherit",
  });
  const timeout = Bun.sleep(config.timeoutMs).then(() => -1);
  const exitCode = await Promise.race([child.exited, timeout]);
  if (exitCode === -1) {
    child.kill();
    await child.exited;
    throw new Error("Stock T3 shim acceptance command timed out.");
  }
  return exitCode;
};

export async function assertPinnedT3Checkout(
  cwd: string,
  expectedCommit: string,
  inspector: AcceptanceGitInspector = defaultGitInspector
): Promise<void> {
  const inspected = await inspector(cwd);
  if (inspected.head !== expectedCommit)
    throw new Error(
      `Shim acceptance T3 checkout is ${inspected.head}, expected pinned ${expectedCommit}.`
    );
  if (inspected.status.trim().length > 0)
    throw new Error(
      "Shim acceptance T3 checkout must be an unmodified worktree."
    );
}

async function defaultGitInspector(
  cwd: string
): Promise<{ readonly head: string; readonly status: string }> {
  const headProcess = Bun.spawn({
    cmd: ["git", "-C", cwd, "rev-parse", "HEAD"],
    stderr: "pipe",
    stdout: "pipe",
  });
  const headOutput = await new Response(headProcess.stdout).text();
  const headExitCode = await headProcess.exited;
  if (headExitCode !== 0)
    throw new Error(
      "Shim acceptance T3 checkout is not a readable git worktree."
    );
  const statusProcess = Bun.spawn({
    cmd: ["git", "-C", cwd, "status", "--porcelain", "--untracked-files=all"],
    stderr: "pipe",
    stdout: "pipe",
  });
  const status = await new Response(statusProcess.stdout).text();
  const statusExitCode = await statusProcess.exited;
  if (statusExitCode !== 0)
    throw new Error("Shim acceptance T3 checkout status could not be read.");
  return { head: headOutput.trim(), status };
}

export function assertPinnedT3Argv(
  actual: readonly string[],
  expected: readonly string[]
): void {
  if (
    actual.length !== expected.length ||
    actual.some((part, index) => part !== expected[index])
  )
    throw new Error(
      "SHIM_ACCEPTANCE_T3_ARGV must exactly match the verified reference t3Argv."
    );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecordValue(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function isSafeNumber(value: unknown): value is number {
  return (
    Object.prototype.toString.call(value) === "[object Number]" &&
    Number.isSafeInteger(value)
  );
}

function rowRecord(value: unknown, rowId: string): MatrixRecord {
  if (!isRecordValue(value))
    throw new Error(`Shim acceptance matrix row ${rowId} is not an object.`);
  return value;
}

function assertRowRequest(
  row: MatrixRecord,
  rowId: string,
  operation: ComparableScenario["operations"][number]
): void {
  const request = row.request;
  if (!isRecordValue(request))
    throw new Error(
      `Shim acceptance matrix row ${rowId} request comparison is unsupported.`
    );
  const keys = Object.keys(request);
  if (keys.some((key) => key !== "method" && key !== "path"))
    throw new Error(
      `Shim acceptance matrix row ${rowId} requests fields not present in scenario reports.`
    );
  const method = request.method;
  const path = request.path;
  if (!isStringValue(method) || !isStringValue(path))
    throw new Error(
      `Shim acceptance matrix row ${rowId} needs comparable request method/path.`
    );
  if (
    operation.method.toUpperCase() !== method.toUpperCase() ||
    !pathMatches(path, operation.path)
  )
    throw new Error(
      `Shim acceptance matrix row ${rowId} request does not match its scenario operation.`
    );
}

function assertRowResponse(
  row: MatrixRecord,
  rowId: string,
  operation: ComparableScenario["operations"][number]
): void {
  const response = row.response;
  if (!isRecordValue(response))
    throw new Error(
      `Shim acceptance matrix row ${rowId} response comparison is unsupported.`
    );
  const keys = Object.keys(response);
  if (keys.some((key) => key !== "status" && key !== "body"))
    throw new Error(
      `Shim acceptance matrix row ${rowId} response fields are not present in scenario reports.`
    );
  if (!isSafeNumber(response.status))
    throw new Error(
      `Shim acceptance matrix row ${rowId} needs comparable response status.`
    );
  if (operation.status !== response.status)
    throw new Error(
      `Shim acceptance matrix row ${rowId} response status mismatches ${operation.status}.`
    );
  if (!Object.hasOwn(response, "body")) return;
  const expectedBody = response.body;
  if (expectedBody === null || isStringValue(expectedBody)) {
    if (operation.body !== expectedBody)
      throw new Error(
        `Shim acceptance matrix row ${rowId} response body mismatches its scenario operation.`
      );
    return;
  }
  if (operation.body === null)
    throw new Error(
      `Shim acceptance matrix row ${rowId} response body mismatches its scenario operation.`
    );
  const actualBody = (() => {
    try {
      return JSON.parse(operation.body) as unknown;
    } catch {
      return undefined;
    }
  })();
  if (actualBody === undefined || !sameJson(expectedBody, actualBody))
    throw new Error(
      `Shim acceptance matrix row ${rowId} response body mismatches its scenario operation.`
    );
}

function assertRowEvents(
  row: MatrixRecord,
  rowId: string,
  scenario: ComparableScenario
): void {
  const events = row.events;
  if (!Array.isArray(events))
    throw new Error(
      `Shim acceptance matrix row ${rowId} events are unsupported.`
    );
  if (events.length === 0) return;
  if (scenario.observedEventTypes.length === 0)
    throw new Error(
      `Shim acceptance matrix row ${rowId} event observations differ.`
    );
  throw new Error(
    `Shim acceptance matrix row ${rowId} requires operation-scoped event fields absent from scenario reports.`
  );
}

function assertRowSupported(row: MatrixRecord, rowId: string): void {
  const normalization = row.normalization;
  if (Array.isArray(normalization) && normalization.length > 0)
    throw new Error(
      `Shim acceptance cannot compare matrix row ${rowId}: normalization is not implemented.`
    );
  if (row.errorBehavior !== "none")
    throw new Error(
      `Shim acceptance matrix row ${rowId} error behavior is not represented in scenario reports.`
    );
  if (
    !isRecordValue(row.stateEffect) ||
    Object.keys(row.stateEffect).length > 0
  )
    throw new Error(
      `Shim acceptance matrix row ${rowId} state effect is not represented in scenario reports.`
    );
}

function assertMatrixRows(
  rows: readonly unknown[],
  reference: ComparableReport,
  shim: ComparableReport
): void {
  const referenceById = new Map(
    reference.scenarios.map((scenario) => [scenario.id, scenario])
  );
  const shimById = new Map(
    shim.scenarios.map((scenario) => [scenario.id, scenario])
  );
  for (const value of rows) {
    const row = rowRecord(value, "unknown");
    const rowId = isStringValue(row.id) ? row.id : "unknown";
    const scenarioId = row.scenario;
    if (!isStringValue(scenarioId))
      throw new Error(`Shim acceptance matrix row ${rowId} has no scenario.`);
    const expected = referenceById.get(scenarioId);
    const actual = shimById.get(scenarioId);
    if (expected === undefined || actual === undefined)
      throw new Error(
        `Shim acceptance matrix row ${rowId} references missing scenario ${scenarioId}.`
      );
    if (row.support === "excluded") continue;
    if (
      row.support === "conditional" &&
      expected.applicability === "not-applicable" &&
      actual.applicability === "not-applicable"
    )
      continue;
    if (row.support !== "required" && row.support !== "conditional")
      throw new Error(
        `Shim acceptance matrix row ${rowId} has unsupported support value.`
      );
    assertRowSupported(row, rowId);
    if (
      expected.applicability !== "required" ||
      actual.applicability !== "required"
    )
      throw new Error(
        `Shim acceptance matrix row ${rowId} requires non-applicable scenario ${scenarioId}.`
      );
    const request = row.request;
    if (
      !isRecordValue(request) ||
      !isStringValue(request.method) ||
      !isStringValue(request.path)
    )
      throw new Error(
        `Shim acceptance matrix row ${rowId} needs comparable request method/path.`
      );
    const requestMethod = request.method;
    const requestPath = request.path;
    const findOperation = (scenario: ComparableScenario) => {
      const matches = scenario.operations.filter(
        (operation) =>
          operation.method.toUpperCase() === requestMethod.toUpperCase() &&
          pathMatches(requestPath, operation.path)
      );
      if (matches.length !== 1)
        throw new Error(
          `Shim acceptance matrix row ${rowId} does not select exactly one operation in ${scenario.id}.`
        );
      return matches[0];
    };
    const expectedOperation = findOperation(expected);
    const actualOperation = findOperation(actual);
    assertRowRequest(row, rowId, expectedOperation);
    assertRowRequest(row, rowId, actualOperation);
    assertRowResponse(row, rowId, expectedOperation);
    assertRowResponse(row, rowId, actualOperation);
    assertRowEvents(row, rowId, expected);
    assertRowEvents(row, rowId, actual);
  }
}

function assertScenarioOperationsEquivalent(
  reference: ComparableScenario,
  shim: ComparableScenario
): void {
  if (reference.operations.length !== shim.operations.length)
    throw new Error(
      `Shim acceptance operation count differs for ${reference.id}.`
    );
  for (const [index, expected] of reference.operations.entries()) {
    const actual = shim.operations[index];
    if (
      actual === undefined ||
      actual.method.toUpperCase() !== expected.method.toUpperCase() ||
      actual.path !== expected.path ||
      actual.status !== expected.status ||
      actual.body !== expected.body
    )
      throw new Error(
        `Shim acceptance operation ${index + 1} differs for ${reference.id}.`
      );
  }
}

/** Compare observations from the same stock-T3 scenario harness. */
export function assertEquivalentScenarioReports(
  reference: ComparableReport,
  shim: ComparableReport,
  matrixRows: readonly unknown[] = []
): void {
  if (reference.corpusId !== shim.corpusId)
    throw new Error("Shim acceptance report corpus does not match reference.");
  assertMatrixRows(matrixRows, reference, shim);
  const referenceById = new Map(
    reference.scenarios.map((scenario) => [scenario.id, scenario])
  );
  const shimById = new Map(
    shim.scenarios.map((scenario) => [scenario.id, scenario])
  );
  for (const id of REQUIRED_REFERENCE_SCENARIOS) {
    const expected = referenceById.get(id);
    const actual = shimById.get(id);
    if (expected === undefined || actual === undefined)
      throw new Error(`Shim acceptance is missing scenario ${id}.`);
    if (expected.applicability !== actual.applicability)
      throw new Error(`Shim acceptance applicability differs for ${id}.`);
    if (expected.applicability === "not-applicable") continue;
    assertScenarioOperationsEquivalent(expected, actual);
    if (!sameJson(expected.observedEventTypes, actual.observedEventTypes))
      throw new Error(`Shim acceptance event observations differ for ${id}.`);
    if (!sameJson(expected.canonicalState, actual.canonicalState))
      throw new Error(`Shim acceptance canonical state differs for ${id}.`);
  }
}

export function assertAcceptanceReport(
  report: ScenarioReport,
  expectedScenarios: readonly string[] = REQUIRED_REFERENCE_SCENARIOS
): void {
  if (report.status !== "completed")
    throw new Error(
      "Shim acceptance is partial; all applicable scenarios must pass."
    );
  const expected = new Set(expectedScenarios);
  const actual = new Set(report.scenarios.map((scenario) => scenario.id));
  if (actual.size !== report.scenarios.length)
    throw new Error("Shim acceptance repeats a scenario.");
  for (const id of expected) {
    if (!actual.has(id))
      throw new Error(`Shim acceptance is missing scenario ${id}.`);
  }
  for (const id of actual) {
    if (!expected.has(id))
      throw new Error(`Shim acceptance contains unexpected scenario ${id}.`);
  }
  for (const scenario of report.scenarios) {
    if (scenario.applicability === "not-applicable") {
      if (
        !isStringValue(scenario.skipReason) ||
        scenario.skipReason.trim().length === 0
      )
        throw new Error(
          `Shim acceptance not-applicable scenario ${scenario.id} needs skipReason.`
        );
      continue;
    }
    if (!Object.hasOwn(scenario, "declaredState"))
      throw new Error(
        `Shim acceptance is missing declared state for ${scenario.id}.`
      );
    if (!Object.hasOwn(scenario, "canonicalState"))
      throw new Error(
        `Shim acceptance is missing canonical state for ${scenario.id}.`
      );
    const canonicalState = scenario.canonicalState;
    if (!isRecordValue(canonicalState) || canonicalState.source !== "t3")
      throw new Error(
        `Shim acceptance canonical state for ${scenario.id} is not T3-sourced.`
      );
  }
  const failed = report.scenarios.filter(
    (scenario) => scenario.applicability === "required" && !scenario.passed
  );
  if (failed.length > 0)
    throw new Error(
      `Shim acceptance contains failed scenarios: ${failed
        .map((scenario) => scenario.id)
        .join(", ")}.`
    );
}

async function loadReferenceScenarioReport(manifestPath: string): Promise<{
  readonly manifestT3Commit: string;
  readonly manifestT3Argv: readonly string[];
  readonly report: ComparableReport;
}> {
  const manifest = await verifyReferenceArtifacts(manifestPath);
  const scenarioPath =
    manifest.scenarioOutput ?? `artifacts/runs/${manifest.corpusId}.json`;
  const report = decodeScenarioReport(
    JSON.parse(await Bun.file(scenarioPath).text()) as unknown
  );
  if (report.corpusId !== manifest.corpusId || report.runId !== manifest.runId)
    throw new Error("Reference scenario report does not match its manifest.");
  return {
    manifestT3Commit: manifest.t3Commit,
    manifestT3Argv: manifest.t3Argv,
    report: {
      corpusId: report.corpusId,
      scenarios: report.scenarios,
      status: report.status,
    },
  };
}

async function loadShimScenarioReport(
  path: string,
  target: string,
  runId: string,
  startedAtMs: number
): Promise<ScenarioReport> {
  const file = Bun.file(path);
  if (!(await file.exists()))
    throw new Error(`Shim scenario report ${path} was not produced.`);
  if (file.lastModified < startedAtMs)
    throw new Error(
      `Shim scenario report ${path} predates this acceptance run.`
    );
  const report = decodeScenarioReport(JSON.parse(await file.text()) as unknown);
  if (report.runId !== runId)
    throw new Error(
      "Shim scenario report runId does not match this acceptance run."
    );
  return {
    baseUrl: target,
    corpusId: report.corpusId,
    generatedAt: new Date().toISOString(),
    runId: report.runId,
    scenarios: report.scenarios,
    status: report.status,
  } as unknown as ScenarioReport;
}

export async function runAcceptance(
  target: string,
  output: string,
  timeoutMs: number,
  corpusId: string | null,
  barrierUrl: string | undefined,
  scenarioOutput = Bun.env.SHIM_ACCEPTANCE_SCENARIO_OUTPUT,
  options: AcceptanceOptions = {}
): Promise<ScenarioReport> {
  const matrix = await loadMatrix();
  if (matrix.status !== "frozen")
    throw new Error("Shim acceptance requires a frozen reference matrix.");
  if (corpusId === null) throw new Error("Shim acceptance requires CORPUS_ID.");
  if (matrix.corpusId !== corpusId)
    throw new Error("Shim acceptance corpus does not match the frozen matrix.");
  await validateMatrix();
  if (target.trim().length === 0)
    throw new Error("Shim acceptance target is required.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("Shim acceptance timeout must be a positive integer.");
  const referenceManifestPath = Bun.env.REFERENCE_MANIFEST;
  if (
    referenceManifestPath === undefined ||
    referenceManifestPath.trim().length === 0
  )
    throw new Error("Shim acceptance requires REFERENCE_MANIFEST.");
  const referenceEvidence = await loadReferenceScenarioReport(
    referenceManifestPath
  );
  if (Bun.env.SHIM_ACCEPTANCE_T3_KIND !== "stock-t3-opencode-adapter")
    throw new Error(
      "SHIM_ACCEPTANCE_T3_KIND must be stock-t3-opencode-adapter."
    );
  const t3Argv = readArgv("SHIM_ACCEPTANCE_T3_ARGV");
  assertPinnedT3Argv(t3Argv, referenceEvidence.manifestT3Argv);
  const t3Cwd = Bun.env.SHIM_ACCEPTANCE_T3_CWD;
  if (t3Cwd === undefined || t3Cwd.trim().length === 0)
    throw new Error("SHIM_ACCEPTANCE_T3_CWD is required.");
  await assertPinnedT3Checkout(
    t3Cwd,
    referenceEvidence.manifestT3Commit,
    options.gitInspector
  );
  const acceptanceRunId = crypto.randomUUID();
  const startedAtMs = Date.now();
  const generatedScenarioOutput = resolve(
    scenarioOutput === undefined || scenarioOutput.trim().length === 0
      ? `${output}.${acceptanceRunId}.scenario.json`
      : scenarioOutput
  );
  await runConfiguredHarness(
    {
      barrierUrl,
      corpusId,
      runId: acceptanceRunId,
      scenarioOutput: generatedScenarioOutput,
      target,
      timeoutMs,
    },
    t3Argv,
    t3Cwd,
    options.processRunner ?? defaultProcessRunner
  );
  const report = await loadShimScenarioReport(
    generatedScenarioOutput,
    target,
    acceptanceRunId,
    startedAtMs
  );
  assertAcceptanceReport(report);
  assertEquivalentScenarioReports(
    referenceEvidence.report,
    report as unknown as ComparableReport,
    matrix.rows
  );
  await mkdir(dirname(output), { recursive: true });
  await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (import.meta.main) {
  const target = Bun.env.SHIM_ACCEPTANCE_TARGET;
  if (target === undefined || target.trim().length === 0)
    throw new Error("SHIM_ACCEPTANCE_TARGET is required.");
  const output =
    Bun.env.SHIM_ACCEPTANCE_OUTPUT ?? "artifacts/runs/shim-acceptance.json";
  const timeoutMs = Number(Bun.env.SHIM_ACCEPTANCE_TIMEOUT_MS ?? 15_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("SHIM_ACCEPTANCE_TIMEOUT_MS must be a positive integer.");
  const report = await runAcceptance(
    target,
    output,
    timeoutMs,
    Bun.env.CORPUS_ID ?? null,
    Bun.env.SCENARIO_BARRIER_URL
  );
  console.log(`shim acceptance ${report.status}; wrote ${output}`);
}
