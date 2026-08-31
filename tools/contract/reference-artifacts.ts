export const REQUIRED_REFERENCE_SCENARIOS = Array.from(
  { length: 19 },
  (_unused, index) => `C${String(index + 1).padStart(2, "0")}`
);

export interface ReferenceManifest {
  readonly capturePath: string;
  readonly client: "stock-t3-opencode-adapter";
  readonly corpusId: string;
  readonly generatedAt: string;
  readonly opencodeArgv: readonly string[];
  readonly runId: string;
  readonly scenarioOutput?: string;
  readonly status: "failed" | "passed";
  readonly t3Argv: readonly string[];
}

export interface ScenarioReportEntry {
  readonly id: string;
  readonly passed: boolean;
  readonly [key: string]: unknown;
}

export interface ScenarioReport {
  readonly corpusId: string;
  readonly runId: string;
  readonly scenarios: readonly ScenarioReportEntry[];
  readonly status: "completed" | "partial";
}

function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isRecord(
  value: unknown
): value is { readonly [key: string]: unknown } {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function requiredString(
  value: { readonly [key: string]: unknown },
  key: string,
  message: string
): string {
  const result = value[key];
  if (!isString(result) || result.trim().length === 0) throw new Error(message);
  return result;
}

function argv(
  value: { readonly [key: string]: unknown },
  key: string
): readonly string[] {
  const result = value[key];
  if (
    !Array.isArray(result) ||
    result.length === 0 ||
    !result.every((item) => isString(item) && item.trim().length > 0)
  )
    throw new Error(
      `Reference manifest ${key} must be a non-empty argv array.`
    );
  return result;
}

export function decodeReferenceManifest(value: unknown): ReferenceManifest {
  if (!isRecord(value))
    throw new Error("Reference manifest must be an object.");
  const client = value.client;
  const status = value.status;
  if (client !== "stock-t3-opencode-adapter")
    throw new Error("Reference manifest client is invalid.");
  if (status !== "failed" && status !== "passed")
    throw new Error("Reference manifest status is invalid.");
  const generatedAt = requiredString(
    value,
    "generatedAt",
    "Reference manifest generatedAt is required."
  );
  if (Number.isNaN(Date.parse(generatedAt)))
    throw new Error("Reference manifest generatedAt must be an ISO timestamp.");
  return {
    capturePath: requiredString(
      value,
      "capturePath",
      "Reference manifest capturePath is required."
    ),
    client,
    corpusId: requiredString(
      value,
      "corpusId",
      "Reference manifest corpusId is required."
    ),
    generatedAt,
    opencodeArgv: argv(value, "opencodeArgv"),
    runId: requiredString(
      value,
      "runId",
      "Reference manifest runId is required."
    ),
    ...(value.scenarioOutput === undefined
      ? {}
      : {
          scenarioOutput: requiredString(
            value,
            "scenarioOutput",
            "Reference manifest scenarioOutput must be non-empty."
          ),
        }),
    status,
    t3Argv: argv(value, "t3Argv"),
  };
}

export function decodeScenarioReport(value: unknown): ScenarioReport {
  if (!isRecord(value)) throw new Error("Scenario report must be an object.");
  const status = value.status;
  if (status !== "completed" && status !== "partial")
    throw new Error("Scenario report status is invalid.");
  const scenarios = value.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length === 0)
    throw new Error("Scenario report must contain scenarios.");
  return {
    corpusId: requiredString(
      value,
      "corpusId",
      "Scenario report corpusId is required."
    ),
    runId: requiredString(value, "runId", "Scenario report runId is required."),
    scenarios: scenarios.map((scenario, index) => {
      if (!isRecord(scenario))
        throw new Error(`Scenario report entry ${index} must be an object.`);
      const id = requiredString(
        scenario,
        "id",
        `Scenario report entry ${index} id is required.`
      );
      if (!/^C[0-9]{2}$/u.test(id))
        throw new Error(`Scenario report entry ${id} has an invalid id.`);
      if (scenario.passed !== true && scenario.passed !== false)
        throw new Error(`Scenario report entry ${id} passed must be boolean.`);
      return { ...scenario, id, passed: scenario.passed };
    }),
    status,
  };
}

export function validateCompletedScenarioReport(
  value: unknown,
  expected: {
    readonly corpusId: string;
    readonly runId: string;
    readonly requiredScenarioIds?: readonly string[];
  }
): ScenarioReport {
  const report = decodeScenarioReport(value);
  if (report.status !== "completed")
    throw new Error("Scenario report is not completed.");
  if (report.corpusId !== expected.corpusId)
    throw new Error(
      "Scenario report corpusId does not match the reference run."
    );
  if (report.runId !== expected.runId)
    throw new Error("Scenario report runId does not match the reference run.");

  const required = expected.requiredScenarioIds ?? REQUIRED_REFERENCE_SCENARIOS;
  const requiredSet = new Set(required);
  const ids = new Set<string>();
  for (const scenario of report.scenarios) {
    if (ids.has(scenario.id))
      throw new Error(`Scenario report repeats ${scenario.id}.`);
    ids.add(scenario.id);
    if (!requiredSet.has(scenario.id))
      throw new Error(`Scenario report contains unexpected ${scenario.id}.`);
    if (!scenario.passed)
      throw new Error(`Scenario report contains failed ${scenario.id}.`);
  }
  for (const id of required) {
    if (!ids.has(id)) throw new Error(`Scenario report is missing ${id}.`);
  }
  return report;
}
