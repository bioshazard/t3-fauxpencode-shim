import type { CreateSessionInput } from "./sessions.ts";
import type { JsonValue, PromptInput, PromptImage } from "./types.ts";

type JsonObject = { readonly [key: string]: JsonValue };

export type CreateSessionRequest =
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly input: Omit<CreateSessionInput, "id"> & { readonly id?: string };
      readonly kind: "ok";
    };

export type PromptRequest =
  | { readonly kind: "error"; readonly message: string }
  | { readonly input: PromptInput; readonly kind: "ok" };

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

function dataUrlImage(record: JsonObject): PromptImage | null {
  const data = readString(record, "data");
  const mime = readString(record, "mimeType") ?? readString(record, "mime");
  if (
    data !== undefined &&
    data !== null &&
    mime !== undefined &&
    mime !== null
  ) {
    return { data, mimeType: mime };
  }
  const url = readString(record, "url");
  if (url === undefined || url === null || !url.startsWith("data:"))
    return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const metadata = url.slice(5, comma).split(";");
  const mimeType = metadata[0] ?? "application/octet-stream";
  const payload = url.slice(comma + 1);
  return {
    data: metadata.includes("base64") ? payload : btoa(payload),
    mimeType,
  };
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
  const title = readString(record, "title");
  if (cwd === null || id === null || title === null) {
    return {
      kind: "error",
      message: "`cwd`, `id`, and `title` must be strings when provided.",
    };
  }
  return {
    input: {
      ...(cwd === undefined ? { cwd: fallbackCwd } : { cwd }),
      ...(id === undefined ? {} : { id }),
      ...(title === undefined ? {} : { title }),
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
  const prompt = readString(record, "prompt");
  const images: PromptImage[] = [];
  const parts = record.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const partRecord = asObject(part);
      if (partRecord === null) continue;
      const partType = readString(partRecord, "type");
      if (partType === "text") continue;
      if (partType !== "file" && partType !== "image") continue;
      const image = dataUrlImage(partRecord);
      if (image !== null) images.push(image);
    }
  }
  const modelRecord = asObject(record.model as JsonValue);
  const providerId =
    modelRecord === null ? undefined : readString(modelRecord, "providerID");
  const modelId =
    modelRecord === null ? undefined : readString(modelRecord, "modelID");
  if (
    providerId === null ||
    modelId === null ||
    (providerId !== undefined && modelId === undefined) ||
    (providerId === undefined && modelId !== undefined)
  ) {
    return {
      kind: "error",
      message:
        "`model.providerID` and `model.modelID` must be strings when provided.",
    };
  }
  const agent = readString(record, "agent");
  const variant = readString(record, "variant");
  if (agent === null || variant === null) {
    return {
      kind: "error",
      message: "`agent` and `variant` must be strings when provided.",
    };
  }
  const messageId = readString(record, "messageID");
  if (messageId === null)
    return {
      kind: "error",
      message: "`messageID` must be a string when provided.",
    };
  if (directText !== undefined && directText !== null) {
    return {
      input: {
        images,
        text: directText,
        ...(agent === undefined ? {} : { agent }),
        ...(messageId === undefined ? {} : { messageId }),
        ...(providerId === undefined || modelId === undefined
          ? {}
          : { model: { modelId, providerId } }),
        ...(variant === undefined ? {} : { variant }),
      },
      kind: "ok",
    };
  }
  if (directText === null)
    return { kind: "error", message: "`text` must be a string." };
  if (prompt !== undefined && prompt !== null)
    return {
      input: {
        images,
        text: prompt,
        ...(agent === undefined ? {} : { agent }),
        ...(messageId === undefined ? {} : { messageId }),
        ...(providerId === undefined || modelId === undefined
          ? {}
          : { model: { modelId, providerId } }),
        ...(variant === undefined ? {} : { variant }),
      },
      kind: "ok",
    };
  if (prompt === null)
    return { kind: "error", message: "`prompt` must be a string." };

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
      return {
        input: {
          images,
          text: partText,
          ...(agent === undefined ? {} : { agent }),
          ...(messageId === undefined ? {} : { messageId }),
          ...(providerId === undefined || modelId === undefined
            ? {}
            : { model: { modelId, providerId } }),
          ...(variant === undefined ? {} : { variant }),
        },
        kind: "ok",
      };
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
