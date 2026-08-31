import { resolve } from "node:path";

import { loadCapture } from "./capture.ts";
import {
  decodeReferenceManifest,
  isRecordValue,
  isStringValue,
  sha256File,
  validateReferenceCorrelations,
  validateCompletedScenarioReport,
  type ReferenceManifest,
  type ScenarioOperation,
  type ScenarioReport,
} from "./reference-artifacts.ts";

type JsonRecord = { readonly [key: string]: unknown };

async function readJson(path: string | URL): Promise<unknown> {
  try {
    return JSON.parse(await Bun.file(path).text()) as unknown;
  } catch {
    throw new Error(`Reference artifact ${path} is missing or invalid JSON.`);
  }
}

async function readPinnedManifest(): Promise<JsonRecord> {
  const value = await readJson(
    new URL("../../contracts/manifest.json", import.meta.url)
  );
  if (
    !isRecordValue(value) ||
    !isRecordValue(value.subjects) ||
    !isRecordValue(value.subjects.t3Code) ||
    !isRecordValue(value.subjects.openCode) ||
    !isRecordValue(value.subjects.pi)
  )
    throw new Error("Pinned manifest is invalid.");
  return value;
}

function requirePinnedString(
  value: JsonRecord,
  key: string,
  label: string
): string {
  const result = value[key];
  if (!isStringValue(result) || result.trim().length === 0)
    throw new Error(`Pinned manifest is missing ${label}.`);
  return result;
}

async function validatePinnedIdentity(
  manifest: ReferenceManifest
): Promise<void> {
  const pinned = await readPinnedManifest();
  if (manifest.corpusId !== requirePinnedString(pinned, "corpusId", "corpusId"))
    throw new Error("Reference manifest does not match pinned corpus.");
  const subjects = pinned.subjects as JsonRecord;
  const t3 = subjects.t3Code as JsonRecord;
  const openCode = subjects.openCode as JsonRecord;
  const pi = subjects.pi as JsonRecord;
  const expected = [
    [manifest.t3Commit, requirePinnedString(t3, "commit", "T3 commit")],
    [
      manifest.openCodeCommit,
      requirePinnedString(openCode, "commit", "OpenCode commit"),
    ],
    [
      manifest.provenance?.subjects.t3Code.repository,
      requirePinnedString(t3, "repository", "T3 repository"),
    ],
    [
      manifest.provenance?.subjects.t3Code.package,
      requirePinnedString(t3, "package", "T3 package"),
    ],
    [
      manifest.provenance?.subjects.t3Code.packageVersion,
      requirePinnedString(t3, "packageVersion", "T3 package version"),
    ],
    [
      manifest.provenance?.subjects.t3Code.packageManager,
      requirePinnedString(t3, "packageManager", "T3 package manager"),
    ],
    [
      manifest.provenance?.subjects.openCode.repository,
      requirePinnedString(openCode, "repository", "OpenCode repository"),
    ],
    [
      manifest.provenance?.subjects.openCode.package,
      requirePinnedString(openCode, "sdkPackage", "OpenCode package"),
    ],
    [
      manifest.provenance?.subjects.openCode.packageVersion,
      requirePinnedString(openCode, "sdkVersion", "OpenCode package version"),
    ],
    [
      manifest.provenance?.subjects.openCode.packageManager,
      requirePinnedString(
        openCode,
        "packageManager",
        "OpenCode package manager"
      ),
    ],
    [
      manifest.provenance?.subjects.pi.repository,
      requirePinnedString(pi, "repository", "Pi repository"),
    ],
    [
      manifest.provenance?.subjects.pi.package,
      requirePinnedString(pi, "package", "Pi package"),
    ],
    [
      manifest.provenance?.subjects.pi.packageVersion,
      requirePinnedString(pi, "packageVersion", "Pi package version"),
    ],
  ] as const;
  if (expected.some(([actual, wanted]) => actual !== wanted))
    throw new Error("Reference manifest does not match pinned corpus.");
}

function operationMatches(
  operation: ScenarioOperation,
  record: {
    readonly body: { readonly response: string | null };
    readonly request: { readonly method: string; readonly path: string };
    readonly response?: { readonly status: number };
  }
): boolean {
  if (
    record.request.method.toUpperCase() !== operation.method.toUpperCase() ||
    record.request.path !== operation.path
  )
    return false;
  if (operation.status === null) return record.response === undefined;
  if (record.response?.status !== operation.status) return false;
  return operation.body === null || record.body.response === operation.body;
}

export function validateScenarioOperations(
  report: ScenarioReport,
  records: readonly {
    readonly correlation?: Readonly<Record<string, string>>;
    readonly body: { readonly response: string | null };
    readonly request: { readonly method: string; readonly path: string };
    readonly response?: { readonly status: number };
  }[]
): void {
  const byScenario = new Map<string, Array<(typeof records)[number]>>();
  for (const record of records) {
    const id = record.correlation?.["x-contract-scenario"];
    if (id === undefined) continue;
    const entries = byScenario.get(id) ?? [];
    entries.push(record);
    byScenario.set(id, entries);
  }
  for (const scenario of report.scenarios) {
    if (scenario.applicability === "not-applicable") continue;
    const captured = byScenario.get(scenario.id) ?? [];
    let offset = 0;
    for (const [index, operation] of scenario.operations.entries()) {
      const match = captured.findIndex(
        (record, recordIndex) =>
          recordIndex >= offset && operationMatches(operation, record)
      );
      if (match < 0)
        throw new Error(
          `Scenario ${scenario.id} operation ${index + 1} has no matching raw capture.`
        );
      offset = match + 1;
    }
  }
}

export async function verifyReferenceArtifacts(
  manifestPath: string
): Promise<ReferenceManifest> {
  const manifest = decodeReferenceManifest(await readJson(manifestPath));
  if (manifest.status !== "passed")
    throw new Error("Reference manifest is not a passed corpus.");
  if (
    manifest.captureSha256 === undefined ||
    manifest.scenarioSha256 === undefined
  )
    throw new Error("Reference manifest is missing artifact checksums.");
  await validatePinnedIdentity(manifest);

  const capturePath = resolve(manifest.capturePath);
  const scenarioPath = resolve(
    manifest.scenarioOutput ?? `artifacts/runs/${manifest.corpusId}.json`
  );
  if (!(await Bun.file(capturePath).exists()))
    throw new Error(`Reference capture ${capturePath} does not exist.`);
  if (!(await Bun.file(scenarioPath).exists()))
    throw new Error(
      `Reference scenario report ${scenarioPath} does not exist.`
    );

  const captureSha256 = await sha256File(capturePath);
  if (captureSha256 !== manifest.captureSha256)
    throw new Error(`Reference capture checksum mismatch for ${capturePath}.`);
  const scenarioSha256 = await sha256File(scenarioPath);
  if (scenarioSha256 !== manifest.scenarioSha256)
    throw new Error(
      `Reference scenario checksum mismatch for ${scenarioPath}.`
    );

  const records = await loadCapture(capturePath);
  if (records.length === 0)
    throw new Error("Reference capture contains no records.");
  const report = validateCompletedScenarioReport(await readJson(scenarioPath), {
    corpusId: manifest.corpusId,
    runId: manifest.runId,
  });
  const capturedScenarios = validateReferenceCorrelations(
    records,
    manifest.runId
  );
  for (const scenario of report.scenarios) {
    if (scenario.applicability === "not-applicable") continue;
    if (!capturedScenarios.has(scenario.id))
      throw new Error(
        `Reference capture is missing raw capture for ${scenario.id}.`
      );
  }
  validateScenarioOperations(report, records);

  return manifest;
}

if (import.meta.main) {
  const manifestPath = Bun.argv[2] ?? Bun.env.REFERENCE_MANIFEST;
  if (manifestPath === undefined || manifestPath.trim().length === 0)
    throw new Error("Reference manifest input is required.");
  const manifest = await verifyReferenceArtifacts(manifestPath);
  console.log(
    `verified reference corpus ${manifest.corpusId}; capture ${manifest.captureSha256}; scenarios ${manifest.scenarioSha256}`
  );
}
