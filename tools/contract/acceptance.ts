import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { validateMatrix } from "./matrix.ts";
import { runScenarios, type ScenarioReport } from "./scenarios.ts";

export function assertAcceptanceReport(report: ScenarioReport): void {
  if (report.status !== "completed")
    throw new Error(
      "Shim acceptance is partial; all applicable scenarios must pass."
    );
  if (report.scenarios.length === 0)
    throw new Error("Shim acceptance produced no scenarios.");
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
