import type { CreateSessionInput } from "./sessions.ts";
import type { JsonValue } from "./types.ts";

type JsonObject = { readonly [key: string]: JsonValue };

export type CreateSessionRequest =
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly input: Omit<CreateSessionInput, "id"> & { readonly id?: string };
      readonly kind: "ok";
    };

function asObject(value: JsonValue): JsonObject | null {
  if (value === null || Array.isArray(value)) return null;
  return Object.prototype.toString.call(value) === "[object Object]"
    ? (value as JsonObject)
    : null;
}

function readString(
  record: JsonObject,
  key: string
): string | null | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (Object.prototype.toString.call(value) !== "[object String]") return null;
  return String(value);
}

export async function readCreateSessionRequest(
  request: Request,
  fallbackCwd: string
): Promise<CreateSessionRequest> {
  const body = await request.text();
  if (body.trim().length === 0)
    return { input: { cwd: fallbackCwd }, kind: "ok" };

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(body) as JsonValue;
  } catch {
    return { kind: "error", message: "Request body must be valid JSON." };
  }
  const record = asObject(parsed);
  if (record === null)
    return { kind: "error", message: "Request body must be a JSON object." };

  const cwd = readString(record, "cwd");
  const id = readString(record, "id");
  if (cwd === null || id === null) {
    return {
      kind: "error",
      message: "`cwd` and `id` must be strings when provided.",
    };
  }
  return {
    input: {
      ...(cwd === undefined ? { cwd: fallbackCwd } : { cwd }),
      ...(id === undefined ? {} : { id }),
    },
    kind: "ok",
  };
}
