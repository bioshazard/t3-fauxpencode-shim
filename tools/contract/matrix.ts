import type { JsonValue } from "../../src/types.ts";
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
}

if (import.meta.main) {
  const matrix = await loadMatrix();
  await validateMatrix(Bun.argv[2] ?? Bun.env.REFERENCE_MANIFEST);
  console.log(`validated ${matrix.rows.length} matrix rows (${matrix.status})`);
}
