import { createHash } from "node:crypto";

export const REQUIRED_REFERENCE_SCENARIOS = Array.from(
  { length: 19 },
  (_unused, index) => `C${String(index + 1).padStart(2, "0")}`
);

export function isRequiredReferenceScenario(value: string): boolean {
  return REQUIRED_REFERENCE_SCENARIOS.includes(value);
}

export function validateReferenceCorrelations(
  records: readonly {
    readonly correlation?: Readonly<Record<string, string>>;
  }[],
  runId: string
): ReadonlySet<string> {
  const scenarios = new Set<string>();
  for (const record of records) {
    if (record.correlation?.["x-contract-run-id"] !== runId)
      throw new Error("Reference capture contains a record from another run.");
    const scenario = record.correlation?.["x-contract-scenario"];
    if (scenario === undefined || !isRequiredReferenceScenario(scenario))
      throw new Error(
        "Reference capture contains an exchange without a known scenario."
      );
    scenarios.add(scenario);
  }
  return scenarios;
}

export interface ReferenceManifest {
  readonly captureSha256?: string;
  readonly capturePath: string;
  readonly client: "stock-t3-opencode-adapter";
  readonly corpusId: string;
  readonly generatedAt: string;
  readonly openCodeCommit: string;
  readonly opencodeArgv: readonly string[];
  readonly provenance?: ReferenceProvenance;
  readonly runId: string;
  readonly scenarioSha256?: string;
  readonly scenarioOutput?: string;
  readonly status: "failed" | "passed";
  readonly t3Commit: string;
  readonly t3Argv: readonly string[];
}

export interface ReferenceProvenance {
  readonly model: {
    readonly fixture: string;
    readonly model: string;
    readonly provider: string;
  };
  readonly runtime: {
    readonly architecture: string;
    readonly nodeVersion: string;
    readonly operatingSystem: string;
    readonly packageManager: string;
  };
  readonly subjects: {
    readonly openCode: {
      readonly package: string;
      readonly packageManager: string;
      readonly packageVersion: string;
      readonly repository: string;
    };
    readonly pi: {
      readonly package: string;
      readonly packageVersion: string;
      readonly repository?: string;
    };
    readonly t3Code: {
      readonly package: string;
      readonly packageManager: string;
      readonly packageVersion: string;
      readonly repository: string;
    };
  };
}

export interface ScenarioReportEntry {
  readonly applicability: "required" | "not-applicable";
  readonly canonicalState: unknown;
  readonly declaredState: unknown;
  readonly expectedTerminal: string;
  readonly failures: readonly string[];
  readonly id: string;
  readonly observedEventTypes: readonly string[];
  readonly operations: readonly ScenarioOperation[];
  readonly passed: boolean;
  readonly skipReason?: string;
  readonly [key: string]: unknown;
}

export interface ScenarioOperation {
  readonly body: string | null;
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly transportError?: string;
}

export interface ScenarioReport {
  readonly corpusId: string;
  readonly runId: string;
  readonly scenarios: readonly ScenarioReportEntry[];
  readonly status: "completed" | "partial";
}

export function isStringValue(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isNumberValue(value: unknown): value is number {
  return Object.prototype.toString.call(value) === "[object Number]";
}

export function isRecordValue(
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
  if (!isStringValue(result) || result.trim().length === 0)
    throw new Error(message);
  return result;
}

function requireEvidenceSource(
  value: unknown,
  name: string
): { readonly source: string } {
  if (!isRecordValue(value) || !isStringValue(value.source))
    throw new Error(`${name} evidence must include a source.`);
  if (value.source.trim().length === 0)
    throw new Error(`${name} evidence source must be non-empty.`);
  return { source: value.source };
}

function readManifestArgv(
  value: { readonly [key: string]: unknown },
  key: string
): readonly string[] {
  const result = value[key];
  if (
    !Array.isArray(result) ||
    result.length === 0 ||
    !result.every((item) => isStringValue(item) && item.trim().length > 0)
  )
    throw new Error(
      `Reference manifest ${key} must be a non-empty argv array.`
    );
  return result;
}

function readManifestCommit(
  value: { readonly [key: string]: unknown },
  key: string
): string {
  const result = requiredString(
    value,
    key,
    `Reference manifest ${key} is required.`
  );
  if (!/^[0-9a-f]{40}$/u.test(result))
    throw new Error(`Reference manifest ${key} must be a 40-character commit.`);
  return result;
}

function readOptionalSha256(
  value: { readonly [key: string]: unknown },
  key: string
): string | undefined {
  if (value[key] === undefined) return undefined;
  const result = requiredString(
    value,
    key,
    `Reference manifest ${key} must be non-empty.`
  );
  if (!/^[0-9a-f]{64}$/u.test(result))
    throw new Error(`Reference manifest ${key} must be a SHA-256 hex digest.`);
  return result;
}

function readScenarioOperation(
  value: unknown,
  scenarioId: string,
  index: number
): ScenarioOperation {
  if (!isRecordValue(value))
    throw new Error(
      `Scenario report entry ${scenarioId} operation ${index + 1} must be an object.`
    );
  const body = value.body;
  const method = value.method;
  const path = value.path;
  const status = value.status;
  if (body !== null && !isStringValue(body))
    throw new Error(
      `Scenario report entry ${scenarioId} operation ${index + 1} body must be string or null.`
    );
  if (!isStringValue(method) || method.trim().length === 0)
    throw new Error(
      `Scenario report entry ${scenarioId} operation ${index + 1} method is required.`
    );
  if (!isStringValue(path) || path.trim().length === 0)
    throw new Error(
      `Scenario report entry ${scenarioId} operation ${index + 1} path is required.`
    );
  if (
    status !== null &&
    (!isNumberValue(status) ||
      !Number.isSafeInteger(status) ||
      status < 100 ||
      status > 599)
  )
    throw new Error(
      `Scenario report entry ${scenarioId} operation ${index + 1} status is invalid.`
    );
  const transportError = value.transportError;
  if (transportError !== undefined && !isStringValue(transportError))
    throw new Error(
      `Scenario report entry ${scenarioId} operation ${index + 1} transportError must be a string.`
    );
  return {
    body: body as string | null,
    method,
    path,
    status: status as number | null,
    ...(transportError === undefined ? {} : { transportError }),
  };
}

function readProvenance(value: unknown): ReferenceProvenance {
  if (!isRecordValue(value))
    throw new Error("Reference manifest provenance must be an object.");
  const model = value.model;
  const runtime = value.runtime;
  const subjects = value.subjects;
  if (
    !isRecordValue(model) ||
    !isRecordValue(runtime) ||
    !isRecordValue(subjects)
  )
    throw new Error("Reference manifest provenance is incomplete.");
  const subject = (
    value: unknown,
    name: string
  ): ReferenceProvenance["subjects"]["t3Code"] => {
    if (!isRecordValue(value))
      throw new Error(`Reference manifest provenance ${name} is invalid.`);
    return {
      package: requiredString(
        value,
        "package",
        `Reference manifest provenance ${name}.package is required.`
      ),
      packageManager: requiredString(
        value,
        "packageManager",
        `Reference manifest provenance ${name}.packageManager is required.`
      ),
      packageVersion: requiredString(
        value,
        "packageVersion",
        `Reference manifest provenance ${name}.packageVersion is required.`
      ),
      repository: requiredString(
        value,
        "repository",
        `Reference manifest provenance ${name}.repository is required.`
      ),
    };
  };
  const t3Code = subject(subjects.t3Code, "t3Code");
  const openCode = subject(subjects.openCode, "openCode");
  const piValue = subjects.pi;
  if (!isRecordValue(piValue))
    throw new Error("Reference manifest provenance pi is invalid.");
  return {
    model: {
      fixture: requiredString(
        model,
        "fixture",
        "Reference manifest provenance model.fixture is required."
      ),
      model: requiredString(
        model,
        "model",
        "Reference manifest provenance model.model is required."
      ),
      provider: requiredString(
        model,
        "provider",
        "Reference manifest provenance model.provider is required."
      ),
    },
    runtime: {
      architecture: requiredString(
        runtime,
        "architecture",
        "Reference manifest provenance runtime.architecture is required."
      ),
      nodeVersion: requiredString(
        runtime,
        "nodeVersion",
        "Reference manifest provenance runtime.nodeVersion is required."
      ),
      operatingSystem: requiredString(
        runtime,
        "operatingSystem",
        "Reference manifest provenance runtime.operatingSystem is required."
      ),
      packageManager: requiredString(
        runtime,
        "packageManager",
        "Reference manifest provenance runtime.packageManager is required."
      ),
    },
    subjects: {
      openCode,
      pi: {
        package: requiredString(
          piValue,
          "package",
          "Reference manifest provenance pi.package is required."
        ),
        packageVersion: requiredString(
          piValue,
          "packageVersion",
          "Reference manifest provenance pi.packageVersion is required."
        ),
        ...(piValue.repository === undefined
          ? {}
          : {
              repository: requiredString(
                piValue,
                "repository",
                "Reference manifest provenance pi.repository is required."
              ),
            }),
      },
      t3Code,
    },
  };
}

export function decodeReferenceManifest(value: unknown): ReferenceManifest {
  if (!isRecordValue(value))
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
  const captureSha256 = readOptionalSha256(value, "captureSha256");
  const scenarioSha256 = readOptionalSha256(value, "scenarioSha256");
  const provenance =
    value.provenance === undefined
      ? undefined
      : readProvenance(value.provenance);
  if (
    status === "passed" &&
    (captureSha256 === undefined ||
      scenarioSha256 === undefined ||
      provenance === undefined)
  )
    throw new Error(
      "Passed reference manifests need checksums and provenance."
    );
  return {
    ...(captureSha256 === undefined ? {} : { captureSha256 }),
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
    openCodeCommit: readManifestCommit(value, "openCodeCommit"),
    opencodeArgv: readManifestArgv(value, "opencodeArgv"),
    ...(provenance === undefined ? {} : { provenance }),
    runId: requiredString(
      value,
      "runId",
      "Reference manifest runId is required."
    ),
    ...(scenarioSha256 === undefined ? {} : { scenarioSha256 }),
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
    t3Commit: readManifestCommit(value, "t3Commit"),
    t3Argv: readManifestArgv(value, "t3Argv"),
  };
}

export function decodeScenarioReport(value: unknown): ScenarioReport {
  if (!isRecordValue(value))
    throw new Error("Scenario report must be an object.");
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
      if (!isRecordValue(scenario))
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
      const expectedTerminal = scenario.expectedTerminal;
      if (
        !isStringValue(expectedTerminal) ||
        expectedTerminal.trim().length === 0
      )
        throw new Error(
          `Scenario report entry ${id} expectedTerminal must be non-empty.`
        );
      const applicability = scenario.applicability;
      if (applicability !== "required" && applicability !== "not-applicable")
        throw new Error(
          `Scenario report entry ${id} applicability must be required or not-applicable.`
        );
      const skipReason = scenario.skipReason;
      if (
        applicability === "not-applicable" &&
        (!isStringValue(skipReason) || skipReason.trim().length === 0)
      )
        throw new Error(
          `Scenario report entry ${id} not-applicable scenarios need skipReason.`
        );
      if (applicability === "required" && skipReason !== undefined)
        throw new Error(
          `Scenario report entry ${id} required scenarios cannot have skipReason.`
        );
      if (!Object.hasOwn(scenario, "declaredState"))
        throw new Error(
          `Scenario report entry ${id} declaredState evidence is required.`
        );
      if (!Object.hasOwn(scenario, "canonicalState"))
        throw new Error(
          `Scenario report entry ${id} canonicalState evidence is required.`
        );
      const declaredState = scenario.declaredState;
      const canonicalState = scenario.canonicalState;
      requireEvidenceSource(
        declaredState,
        `Scenario report entry ${id} declaredState`
      );
      requireEvidenceSource(
        canonicalState,
        `Scenario report entry ${id} canonicalState`
      );
      const operations = scenario.operations;
      if (!Array.isArray(operations) || operations.length === 0)
        throw new Error(
          `Scenario report entry ${id} operations must be non-empty.`
        );
      const decodedOperations = operations.map((operation, operationIndex) =>
        readScenarioOperation(operation, id, operationIndex)
      );
      const observedEventTypes = scenario.observedEventTypes;
      if (
        !Array.isArray(observedEventTypes) ||
        !observedEventTypes.every(isStringValue)
      )
        throw new Error(
          `Scenario report entry ${id} observedEventTypes must be string[].`
        );
      const failures = scenario.failures;
      if (!Array.isArray(failures) || !failures.every(isStringValue))
        throw new Error(
          `Scenario report entry ${id} failures must be string[].`
        );
      if (scenario.passed === true && failures.length > 0)
        throw new Error(
          `Scenario report entry ${id} is passed but contains failures.`
        );
      return {
        ...scenario,
        applicability,
        canonicalState,
        declaredState,
        expectedTerminal,
        failures,
        id,
        observedEventTypes,
        operations: decodedOperations,
        passed: scenario.passed,
        ...(skipReason === undefined
          ? {}
          : { skipReason: skipReason as string }),
      };
    }),
    status,
  };
}

export function validateCompletedScenarioReport(
  value: unknown,
  expected: { readonly corpusId: string; readonly runId: string }
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

  const required = REQUIRED_REFERENCE_SCENARIOS;
  const requiredSet = new Set(required);
  const ids = new Set<string>();
  for (const scenario of report.scenarios) {
    if (ids.has(scenario.id))
      throw new Error(`Scenario report repeats ${scenario.id}.`);
    ids.add(scenario.id);
    if (!requiredSet.has(scenario.id))
      throw new Error(`Scenario report contains unexpected ${scenario.id}.`);
    if (scenario.applicability === "required" && !scenario.passed)
      throw new Error(`Scenario report contains failed ${scenario.id}.`);
    if (scenario.applicability === "not-applicable" && !scenario.passed)
      throw new Error(
        `Scenario report contains a failed not-applicable ${scenario.id}.`
      );
  }
  for (const id of required) {
    if (!ids.has(id)) throw new Error(`Scenario report is missing ${id}.`);
  }
  return report;
}

export async function sha256File(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer();
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}
