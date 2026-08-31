import type { JsonValue } from "../../src/types.ts";

interface Matrix {
  readonly corpusId: string;
  readonly rows: readonly JsonValue[];
  readonly schemaVersion: 1;
  readonly status: "frozen" | "pending-reference-capture";
}

const matrixPath = new URL("../../contracts/matrix.json", import.meta.url);

function isRecord(
  value: JsonValue
): value is { readonly [key: string]: JsonValue } {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function decodeMatrix(value: JsonValue): Matrix {
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
    if (!Array.isArray(row.evidence) || row.evidence.length === 0) {
      throw new Error(`Matrix row ${row.id} needs evidence.`);
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

export async function validateMatrix(): Promise<void> {
  await loadMatrix();
}

if (import.meta.main) {
  const matrix = await loadMatrix();
  console.log(`validated ${matrix.rows.length} matrix rows (${matrix.status})`);
}
