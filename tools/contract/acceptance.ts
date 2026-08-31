import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadMatrix, validateMatrix } from "./matrix.ts";
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

export type AcceptanceHarness = (
  config: AcceptanceHarnessConfig
) => Promise<void>;

export interface AcceptanceOptions {
  readonly harness?: AcceptanceHarness;
}

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
  config: AcceptanceHarnessConfig
): Promise<void> {
  if (Bun.env.SHIM_ACCEPTANCE_T3_KIND !== "stock-t3-opencode-adapter")
    throw new Error(
      "SHIM_ACCEPTANCE_T3_KIND must be stock-t3-opencode-adapter."
    );
  const argv = readArgv("SHIM_ACCEPTANCE_T3_ARGV");
  const cwd = Bun.env.SHIM_ACCEPTANCE_T3_CWD ?? Bun.env.T3_REFERENCE_ROOT;
  if (cwd === undefined || cwd.trim().length === 0)
    throw new Error("SHIM_ACCEPTANCE_T3_CWD or T3_REFERENCE_ROOT is required.");
  const env = {
    ...process.env,
    CAPTURE_TARGET: config.target,
    CONTRACT_RUN_ID: config.runId,
    CORPUS_ID: config.corpusId,
    OPENCODE_BASE_URL: config.target,
    SCENARIO_OUTPUT: config.scenarioOutput,
    SCENARIO_TARGET: config.target,
    SHIM_ACCEPTANCE_TARGET: config.target,
    ...(config.barrierUrl === undefined
      ? {}
      : { SCENARIO_BARRIER_URL: config.barrierUrl }),
  };
  const child = Bun.spawn({
    cmd: [...argv],
    cwd,
    env,
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
  if (exitCode !== 0)
    throw new Error(
      `Stock T3 shim acceptance command exited with ${exitCode}.`
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
  for (const row of matrixRows) {
    if (!isRecordValue(row)) continue;
    const normalization = row.normalization;
    if (Array.isArray(normalization) && normalization.length > 0)
      throw new Error(
        `Shim acceptance cannot compare matrix row ${String(row.id)}: normalization is not implemented.`
      );
  }
  if (reference.corpusId !== shim.corpusId)
    throw new Error("Shim acceptance report corpus does not match reference.");
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

async function loadReferenceScenarioReport(
  manifestPath: string
): Promise<ComparableReport> {
  const manifest = await verifyReferenceArtifacts(manifestPath);
  const scenarioPath =
    manifest.scenarioOutput ?? `artifacts/runs/${manifest.corpusId}.json`;
  const report = decodeScenarioReport(
    JSON.parse(await Bun.file(scenarioPath).text()) as unknown
  );
  if (report.corpusId !== manifest.corpusId || report.runId !== manifest.runId)
    throw new Error("Reference scenario report does not match its manifest.");
  return {
    corpusId: report.corpusId,
    scenarios: report.scenarios,
    status: report.status,
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
  const acceptanceRunId = crypto.randomUUID();
  const startedAtMs = Date.now();
  const generatedScenarioOutput = resolve(
    scenarioOutput === undefined || scenarioOutput.trim().length === 0
      ? `${output}.${acceptanceRunId}.scenario.json`
      : scenarioOutput
  );
  const harness = options.harness ?? runConfiguredHarness;
  await harness({
    barrierUrl,
    corpusId,
    runId: acceptanceRunId,
    scenarioOutput: generatedScenarioOutput,
    target,
    timeoutMs,
  });
  const reference = await loadReferenceScenarioReport(referenceManifestPath);
  const report = await loadShimScenarioReport(
    generatedScenarioOutput,
    target,
    acceptanceRunId,
    startedAtMs
  );
  assertAcceptanceReport(report);
  assertEquivalentScenarioReports(
    reference,
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
