import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { loadMatrix, validateMatrix } from "./matrix.ts";
import { REQUIRED_REFERENCE_SCENARIOS } from "./reference-artifacts.ts";
import { runScenarios, type ScenarioReport } from "./scenarios.ts";

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
    if (!Object.hasOwn(scenario, "declaredState"))
      throw new Error(
        `Shim acceptance is missing declared state for ${scenario.id}.`
      );
    if (!Object.hasOwn(scenario, "canonicalState"))
      throw new Error(
        `Shim acceptance is missing canonical state for ${scenario.id}.`
      );
  }
  const failed = report.scenarios.filter((scenario) => !scenario.passed);
  if (failed.length > 0)
    throw new Error(
      `Shim acceptance contains failed scenarios: ${failed
        .map((scenario) => scenario.id)
        .join(", ")}.`
    );
}

export async function runAcceptance(
  target: string,
  output: string,
  timeoutMs: number,
  corpusId: string | null,
  runId: string | undefined,
  barrierUrl: string | undefined
): Promise<ScenarioReport> {
  const matrix = await loadMatrix();
  if (matrix.status !== "frozen")
    throw new Error("Shim acceptance requires a frozen reference matrix.");
  if (corpusId === null) throw new Error("Shim acceptance requires CORPUS_ID.");
  if (matrix.corpusId !== corpusId)
    throw new Error("Shim acceptance corpus does not match the frozen matrix.");
  await validateMatrix();
  const barrier =
    barrierUrl === undefined
      ? undefined
      : {
          waitFor: async (name: string): Promise<boolean> => {
            const url = new URL("/wait", barrierUrl);
            url.searchParams.set("name", name);
            const response = await fetch(url, { method: "POST" });
            return response.ok;
          },
        };
  const report = await runScenarios(target, corpusId, timeoutMs, {
    ...(barrier === undefined ? {} : { barrier }),
    ...(runId === undefined ? {} : { runId }),
  });
  assertAcceptanceReport(report);
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
    Bun.env.CONTRACT_RUN_ID,
    Bun.env.SCENARIO_BARRIER_URL
  );
  console.log(`shim acceptance ${report.status}; wrote ${output}`);
}
