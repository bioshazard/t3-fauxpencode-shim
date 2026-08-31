import type { CreateSessionInput } from "./sessions.ts";
import type { JsonValue } from "./types.ts";

type JsonObject = { readonly [key: string]: JsonValue };

export type CreateSessionRequest =
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly input: Omit<CreateSessionInput, "id"> & { readonly id?: string };
      readonly kind: "ok";
    };

export type PromptRequest =
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ok"; readonly text: string };

export type RevertRequest =
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ok"; readonly messageId: string };

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

export async function readPromptRequest(
  request: Request
): Promise<PromptRequest> {
  const body = await request.text();
  if (body.trim().length === 0) {
    return { kind: "error", message: "Prompt body is required." };
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(body) as JsonValue;
  } catch {
    return { kind: "error", message: "Request body must be valid JSON." };
  }
  const record = asObject(parsed);
  if (record === null)
    return { kind: "error", message: "Prompt body must be a JSON object." };

  const directText = readString(record, "text");
  if (directText !== undefined && directText !== null) {
    return { kind: "ok", text: directText };
  }
  if (directText === null)
    return { kind: "error", message: "`text` must be a string." };

  const prompt = readString(record, "prompt");
  if (prompt !== undefined && prompt !== null)
    return { kind: "ok", text: prompt };
  if (prompt === null)
    return { kind: "error", message: "`prompt` must be a string." };

  const parts = record.parts;
  if (!Array.isArray(parts)) {
    return {
      kind: "error",
      message: "Prompt body needs `text`, `prompt`, or text `parts`.",
    };
  }
  for (const part of parts) {
    const partRecord = asObject(part);
    if (partRecord === null) continue;
    const partType = readString(partRecord, "type");
    const partText = readString(partRecord, "text");
    if (partType === "text" && partText !== null && partText !== undefined) {
      return { kind: "ok", text: partText };
    }
  }
  return { kind: "error", message: "Prompt body needs a text part." };
}

export async function readRevertRequest(
  request: Request
): Promise<RevertRequest> {
  const body = await request.text();
  if (body.trim().length === 0) {
    return { kind: "error", message: "Revert body needs `messageID`." };
  }

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(body) as JsonValue;
  } catch {
    return { kind: "error", message: "Request body must be valid JSON." };
  }
  const record = asObject(parsed);
  if (record === null)
    return { kind: "error", message: "Revert body must be a JSON object." };
  const messageId =
    readString(record, "messageID") ?? readString(record, "messageId");
  return messageId === undefined || messageId === null
    ? { kind: "error", message: "Revert body needs `messageID`." }
    : { kind: "ok", messageId };
}
