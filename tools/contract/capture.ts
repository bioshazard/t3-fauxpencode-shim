import type { JsonValue } from "../../src/types.ts";
import type { CaptureRecord } from "./recorder.ts";

function isRecord(
  value: unknown
): value is { readonly [key: string]: unknown } {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isNumber(value: unknown): value is number {
  return Object.prototype.toString.call(value) === "[object Number]";
}

function isBoolean(value: unknown): value is boolean {
  return Object.prototype.toString.call(value) === "[object Boolean]";
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || isString(value) || isNumber(value) || isBoolean(value))
    return true;
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item));
  return (
    isRecord(value) && Object.values(value).every((item) => isJsonValue(item))
  );
}

function fail(index: number, message: string): never {
  throw new Error(`Capture record ${index}: ${message}`);
}

function validateHeaders(value: unknown, index: number, name: string): void {
  if (!isRecord(value)) fail(index, `${name} headers must be an object`);
  for (const [key, header] of Object.entries(value)) {
    if (!isString(header)) fail(index, `${name} header ${key} is not a string`);
  }
}

function validateRecord(value: unknown, index: number): CaptureRecord {
  if (!isRecord(value)) fail(index, "record must be an object");
  if (!isNumber(value.sequence) || !Number.isSafeInteger(value.sequence))
    fail(index, "sequence must be a safe integer");
  if (!isString(value.startedAt) || Number.isNaN(Date.parse(value.startedAt)))
    fail(index, "startedAt must be an ISO timestamp");
  if (!isNumber(value.durationMs) || value.durationMs < 0)
    fail(index, "durationMs must be non-negative");

  const request = value.request;
  if (!isRecord(request)) fail(index, "request is missing");
  if (!isString(request.method) || !isString(request.path))
    fail(index, "request method/path must be strings");
  if (!isRecord(request.query)) fail(index, "request query must be an object");
  validateHeaders(request.headers, index, "request");

  const body = value.body;
  if (!isRecord(body)) fail(index, "body is missing");
  for (const key of ["request", "response"]) {
    if (body[key] !== null && !isString(body[key]))
      fail(index, `body.${key} must be a string or null`);
  }
  if (!isBoolean(body.requestTruncated) || !isBoolean(body.responseTruncated))
    fail(index, "body truncation flags must be booleans");

  const connection = value.connection;
  if (!isRecord(connection)) fail(index, "connection is missing");
  if (connection.state !== "closed" && connection.state !== "error")
    fail(index, "connection.state is invalid");
  const reasons = [
    "client-cancelled",
    "normal",
    "server-closed",
    "transport-error",
  ];
  if (!isString(connection.reason) || !reasons.includes(connection.reason))
    fail(index, "connection.reason is invalid");
  if (connection.closedAt !== undefined && !isString(connection.closedAt))
    fail(index, "connection.closedAt must be a string");
  if (value.response !== undefined) {
    if (!isRecord(value.response) || !isNumber(value.response.status))
      fail(index, "response must contain a numeric status");
    validateHeaders(value.response.headers, index, "response");
  }
  if (value.correlation !== undefined)
    validateHeaders(value.correlation, index, "correlation");
  if (!isRecord(value.correlation))
    fail(index, "correlation is required for every exchange");
  if (
    !isString(value.correlation["x-contract-run-id"]) ||
    value.correlation["x-contract-run-id"].trim().length === 0
  )
    fail(index, "correlation is missing x-contract-run-id");
  if (
    !isString(value.correlation["x-contract-scenario"]) ||
    value.correlation["x-contract-scenario"].trim().length === 0
  )
    fail(index, "correlation is missing x-contract-scenario");
  if (body.requestTruncated || body.responseTruncated)
    fail(index, "body is truncated and cannot be reference evidence");

  if (value.sse !== undefined) {
    const sse = value.sse;
    if (!isRecord(sse) || !Array.isArray(sse.frames))
      fail(index, "sse must contain frames");
    if (
      !isNumber(sse.reconnect) ||
      !Number.isSafeInteger(sse.reconnect) ||
      sse.reconnect < 1
    )
      fail(index, "sse.reconnect must be a positive integer");
    if (
      sse.scope !== "global" &&
      sse.scope !== "session" &&
      sse.scope !== "unknown"
    )
      fail(index, "sse.scope is invalid");
    if (sse.remainder !== undefined && !isString(sse.remainder))
      fail(index, "sse.remainder must be a string");
    if (isString(sse.remainder) && sse.remainder.length > 0)
      fail(index, "sse stream ended with an incomplete frame");
    for (const [frameIndex, frame] of sse.frames.entries()) {
      if (!isRecord(frame))
        fail(index, `sse frame ${frameIndex} is not an object`);
      if (!isString(frame.raw) || !isString(frame.data))
        fail(index, `sse frame ${frameIndex} raw/data must be strings`);
      if (frame.event !== null && !isString(frame.event))
        fail(index, `sse frame ${frameIndex} event must be a string or null`);
      if (!Array.isArray(frame.comments) || !frame.comments.every(isString))
        fail(index, `sse frame ${frameIndex} comments must be strings`);
      if (!isNumber(frame.receivedAtMs) || frame.receivedAtMs < 0)
        fail(
          index,
          `sse frame ${frameIndex} receivedAtMs must be non-negative`
        );
      if (frame.id !== undefined && !isString(frame.id))
        fail(index, `sse frame ${frameIndex} id must be a string`);
      if (
        frame.retry !== undefined &&
        (!isNumber(frame.retry) ||
          !Number.isSafeInteger(frame.retry) ||
          frame.retry < 0)
      )
        fail(
          index,
          `sse frame ${frameIndex} retry must be a non-negative integer`
        );
      if (frame.parsed !== undefined && !isJsonValue(frame.parsed))
        fail(index, `sse frame ${frameIndex} parsed is not JSON`);
      if (!/(?:\r?\n){2}$/u.test(frame.raw))
        fail(
          index,
          `sse frame ${frameIndex} raw is missing a blank-line boundary`
        );
    }
  }
  const serialized = JSON.stringify(value);
  if (/(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/u.test(serialized))
    fail(index, "contains an unredacted authorization value");
  if (/\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/u.test(serialized))
    fail(index, "contains an unredacted token");
  return value as unknown as CaptureRecord;
}

export function validateCaptureRecords(
  values: readonly unknown[]
): readonly CaptureRecord[] {
  let previousSequence = 0;
  return values.map((value, index) => {
    const record = validateRecord(value, index);
    if (record.sequence <= previousSequence)
      fail(index, "sequence must increase monotonically");
    previousSequence = record.sequence;
    if (
      record.connection.state === "closed" &&
      record.connection.closedAt === undefined
    )
      fail(index, "closed records need connection.closedAt");
    return record;
  });
}

export async function loadCapture(
  path: string
): Promise<readonly CaptureRecord[]> {
  const text = await Bun.file(path).text();
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("Capture is empty.");
  const values = lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      fail(index, "is not valid JSON");
    }
  });
  return validateCaptureRecords(values);
}

if (import.meta.main) {
  const path = Bun.argv[2] ?? Bun.env.CAPTURE_INPUT;
  if (path === undefined || path.trim().length === 0)
    throw new Error("Capture input is required.");
  const records = await loadCapture(path);
  console.log(`validated ${records.length} capture records`);
}
