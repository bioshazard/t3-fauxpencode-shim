import { resolve } from "node:path";

import type { JsonValue } from "../../src/types.ts";
import { loadCapture } from "./capture.ts";
import {
  decodeScenarioReport,
  validateCompletedScenarioReport,
  type ReferenceManifest,
} from "./reference-artifacts.ts";
import { verifyReferenceArtifacts } from "./reference-verify.ts";

export interface Matrix {
  readonly corpusId: string;
  readonly rows: readonly JsonValue[];
  readonly schemaVersion: 1;
  readonly status: "frozen" | "pending-reference-capture";
}

const matrixPath = new URL("../../contracts/matrix.json", import.meta.url);

function isRecord(
  value: JsonValue | undefined
): value is { readonly [key: string]: JsonValue } {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isNumber(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]";
}

function nonEmptyRecord(value: JsonValue): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

function containsTbd(value: JsonValue): boolean {
  if (isString(value)) return value === "TBD";
  if (Array.isArray(value)) return value.some((item) => containsTbd(item));
  if (isRecord(value))
    return Object.values(value).some((item) => containsTbd(item));
  return false;
}

export function decodeMatrix(value: JsonValue): Matrix {
  if (!isRecord(value)) throw new Error("Matrix must be a JSON object.");
  if (
    value.schemaVersion !== 1 ||
    !isString(value.corpusId) ||
    (value.status !== "frozen" &&
      value.status !== "pending-reference-capture") ||
    !Array.isArray(value.rows)
  ) {
    throw new Error("Matrix header is invalid.");
  }
  const ids = new Set<string>();
  for (const [index, row] of value.rows.entries()) {
    if (!isRecord(row))
      throw new Error(`Matrix row ${index} is not an object.`);
    if (!isString(row.id)) throw new Error(`Matrix row ${index} has no id.`);
    if (ids.has(row.id)) throw new Error(`Duplicate matrix row id: ${row.id}`);
    ids.add(row.id);
    if (!isString(row.scenario))
      throw new Error(`Matrix row ${row.id} has no scenario.`);
    if (!/^C[0-9]{2}$/u.test(row.scenario))
      throw new Error(`Matrix row ${row.id} has an invalid scenario.`);
    const requiredStrings = ["operation", "trigger", "errorBehavior"];
    for (const key of requiredStrings) {
      if (!isString(row[key]))
        throw new Error(`Matrix row ${row.id} needs string ${key}.`);
    }
    for (const key of ["request", "response", "stateEffect"]) {
      if (!isRecord(row[key]))
        throw new Error(`Matrix row ${row.id} needs object ${key}.`);
    }
    if (!Array.isArray(row.events))
      throw new Error(`Matrix row ${row.id} needs events.`);
    if (!Array.isArray(row.normalization))
      throw new Error(`Matrix row ${row.id} needs normalization.`);
    if (!Array.isArray(row.evidence) || row.evidence.length === 0) {
      throw new Error(`Matrix row ${row.id} needs evidence.`);
    }
    if (
      row.confidence !== "observed" &&
      row.confidence !== "source-confirmed" &&
      row.confidence !== "hypothesis"
    ) {
      throw new Error(`Matrix row ${row.id} has invalid confidence.`);
    }
    if (value.status === "frozen" && row.confidence === "hypothesis")
      throw new Error(`Frozen matrix row ${row.id} cannot be a hypothesis.`);
    if (
      row.support !== "required" &&
      row.support !== "conditional" &&
      row.support !== "excluded"
    ) {
      throw new Error(`Matrix row ${row.id} has invalid support.`);
    }
    if (value.status === "frozen" && containsTbd(row)) {
      throw new Error(`Frozen matrix row ${row.id} contains TBD.`);
    }
  }
  if (value.status === "frozen" && value.rows.length === 0) {
    throw new Error("A frozen matrix must contain observed rows.");
  }
  return {
    corpusId: value.corpusId,
    rows: value.rows,
    schemaVersion: 1,
    status: value.status,
  };
}

export async function loadMatrix(): Promise<Matrix> {
  return decodeMatrix((await Bun.file(matrixPath).json()) as JsonValue);
}

export function assertMatrixCorpus(matrix: Matrix, corpusId: string): void {
  if (matrix.corpusId !== corpusId)
    throw new Error(
      `Frozen matrix corpus ${matrix.corpusId} does not match reference corpus ${corpusId}.`
    );
}

interface RawEvidenceReference {
  readonly sequence: number;
  readonly scenario?: string;
}

function readEvidenceReference(
  value: JsonValue,
  rowId: string
): {
  readonly kind: "raw" | "t3";
  readonly reference: RawEvidenceReference | string;
} {
  if (isString(value)) {
    const raw = /^raw:(C[0-9]{2})#([1-9][0-9]*)$/u.exec(value.trim());
    if (raw !== null) {
      const sequence = Number(raw[2]);
      if (Number.isSafeInteger(sequence))
        return { kind: "raw", reference: { scenario: raw[1], sequence } };
    }
    const t3 = /^t3:(.+)$/u.exec(value.trim());
    if (t3 !== null && t3[1].trim().length > 0)
      return { kind: "t3", reference: t3[1].trim() };
  } else if (isRecord(value)) {
    const source = value.source ?? value.kind;
    if (source === "raw" || source === "raw-capture") {
      const sequence = value.sequence;
      const scenario = value.scenario;
      if (
        isNumber(sequence) &&
        Number.isSafeInteger(sequence) &&
        sequence > 0 &&
        (scenario === undefined ||
          (isString(scenario) && /^C[0-9]{2}$/u.test(scenario)))
      )
        return {
          kind: "raw",
          reference: {
            ...(scenario === undefined ? {} : { scenario }),
            sequence,
          },
        };
    }
    if (source === "t3" || source === "t3-source") {
      const reference = value.reference ?? value.symbol ?? value.path;
      if (isString(reference) && reference.trim().length > 0)
        return { kind: "t3", reference: reference.trim() };
    }
  }
  throw new Error(
    `Frozen matrix row ${rowId} has invalid evidence; use raw:C01#1 and t3:<source> references.`
  );
}

function validateRowExpectedBehavior(
  row: { readonly [key: string]: JsonValue },
  rowId: string
): void {
  if (!nonEmptyRecord(row.request) || !nonEmptyRecord(row.response))
    throw new Error(
      `Frozen matrix row ${rowId} needs normalized request and response behavior.`
    );
}

export async function validateMatrixEvidence(
  matrix: Matrix,
  manifest: ReferenceManifest
): Promise<void> {
  const capturePath = resolve(manifest.capturePath);
  const scenarioPath = resolve(
    manifest.scenarioOutput ?? `artifacts/runs/${manifest.corpusId}.json`
  );
  const records = await loadCapture(capturePath);
  const scenarioValue = JSON.parse(
    await Bun.file(scenarioPath).text()
  ) as unknown;
  const report = validateCompletedScenarioReport(
    decodeScenarioReport(scenarioValue),
    { corpusId: manifest.corpusId, runId: manifest.runId }
  );
  const scenarios = new Map(
    report.scenarios.map((scenario) => [scenario.id, scenario])
  );
  const captures = new Map(records.map((record) => [record.sequence, record]));

  for (const rowValue of matrix.rows) {
    if (!isRecord(rowValue)) continue;
    const rowId = String(rowValue.id);
    const scenario = scenarios.get(String(rowValue.scenario));
    if (scenario === undefined)
      throw new Error(
        `Frozen matrix row ${rowId} references missing reference scenario ${String(rowValue.scenario)}.`
      );
    if (
      rowValue.support === "required" &&
      scenario.applicability !== "required"
    )
      throw new Error(
        `Frozen matrix row ${rowId} requires non-applicable reference scenario ${scenario.id}.`
      );
    if (rowValue.support !== "required") continue;

    validateRowExpectedBehavior(rowValue, rowId);
    const evidence = rowValue.evidence as readonly JsonValue[];
    let rawEvidence = 0;
    let t3Evidence = 0;
    for (const value of evidence) {
      const parsed = readEvidenceReference(value, rowId);
      if (parsed.kind === "t3") {
        t3Evidence += 1;
        continue;
      }
      rawEvidence += 1;
      const reference = parsed.reference as RawEvidenceReference;
      const record = captures.get(reference.sequence);
      if (
        record === undefined ||
        record.correlation?.["x-contract-run-id"] !== manifest.runId ||
        record.correlation?.["x-contract-scenario"] !== scenario.id ||
        (reference.scenario !== undefined && reference.scenario !== scenario.id)
      )
        throw new Error(
          `Frozen matrix row ${rowId} raw evidence does not reference ${scenario.id} in the verified capture.`
        );
      const request = rowValue.request;
      if (
        isRecord(request) &&
        isString(request.method) &&
        isString(request.path) &&
        (request.method.toUpperCase() !== record.request.method.toUpperCase() ||
          request.path !== record.request.path)
      )
        throw new Error(
          `Frozen matrix row ${rowId} normalized request does not match raw evidence sequence ${reference.sequence}.`
        );
      const response = rowValue.response;
      if (
        isRecord(response) &&
        isNumber(response.status) &&
        (record.response === undefined ||
          response.status !== record.response.status)
      )
        throw new Error(
          `Frozen matrix row ${rowId} normalized response does not match raw evidence sequence ${reference.sequence}.`
        );
    }
    if (rawEvidence === 0)
      throw new Error(`Frozen matrix row ${rowId} needs raw capture evidence.`);
    if (t3Evidence === 0)
      throw new Error(
        `Frozen matrix row ${rowId} needs T3 consumer/source evidence.`
      );
  }
}

export async function validateMatrix(
  referenceManifestPath = Bun.env.REFERENCE_MANIFEST
): Promise<void> {
  const matrix = await loadMatrix();
  if (matrix.status !== "frozen") return;
  if (
    referenceManifestPath === undefined ||
    referenceManifestPath.trim() === ""
  )
    throw new Error(
      "A frozen matrix requires REFERENCE_MANIFEST or a manifest path argument."
    );
  const manifest = await verifyReferenceArtifacts(referenceManifestPath);
  assertMatrixCorpus(matrix, manifest.corpusId);
  await validateMatrixEvidence(matrix, manifest);
}

if (import.meta.main) {
  const matrix = await loadMatrix();
  await validateMatrix(Bun.argv[2] ?? Bun.env.REFERENCE_MANIFEST);
  console.log(`validated ${matrix.rows.length} matrix rows (${matrix.status})`);
}
