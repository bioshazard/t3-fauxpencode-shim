import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { JsonValue } from "../../src/types.ts";

export interface CaptureConfig {
  readonly maxBodyBytes: number;
  readonly output: string;
  readonly runId: string;
  readonly target: URL;
}

export interface CaptureRecord {
  readonly body: {
    readonly request: string | null;
    readonly requestTruncated: boolean;
    readonly response: string | null;
    readonly responseTruncated: boolean;
  };
  readonly connection: {
    readonly closedAt?: string;
    readonly reason:
      | "client-cancelled"
      | "normal"
      | "server-closed"
      | "transport-error";
    readonly state: "closed" | "error";
  };
  readonly correlation?: Readonly<Record<string, string>>;
  readonly durationMs: number;
  readonly request: {
    readonly headers: Readonly<Record<string, string>>;
    readonly method: string;
    readonly path: string;
    readonly query: Readonly<Record<string, string>>;
  };
  readonly response?: {
    readonly headers: Readonly<Record<string, string>>;
    readonly status: number;
  };
  readonly sequence: number;
  readonly startedAt: string;
  readonly sse?: {
    readonly frames: readonly {
      readonly data: string;
      readonly event: string | null;
      readonly id?: string;
      readonly comments: readonly string[];
      readonly parsed?: JsonValue;
      readonly receivedAtMs: number;
      readonly retry?: number;
      readonly raw: string;
    }[];
    readonly remainder?: string;
    readonly reconnect: number;
    readonly scope: "global" | "session" | "unknown";
  };
  readonly transportError?: string;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function queryRecord(url: URL): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of url.searchParams) result[name] = value;
  return result;
}

function correlationHeaders(
  headers: Headers
): Readonly<Record<string, string>> | undefined {
  const result: Record<string, string> = {};
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (
      lower === "x-contract-run-id" ||
      lower === "x-contract-scenario" ||
      lower === "x-t3-thread-id" ||
      lower === "x-t3-turn-id" ||
      lower === "x-opencode-session-id"
    ) {
      result[lower] = value;
    }
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function bodyText(
  bytes: Uint8Array,
  maxBytes: number
): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const truncated = bytes.byteLength > maxBytes;
  const visible = truncated ? bytes.subarray(0, maxBytes) : bytes;
  return {
    text: new TextDecoder().decode(visible),
    truncated,
  };
}

function targetURL(target: URL, requestURL: URL): URL {
  const result = new URL(requestURL.pathname + requestURL.search, target);
  return result;
}

function sseScope(path: string): "global" | "session" | "unknown" {
  if (path === "/event" || path === "/global/event") return "global";
  if (/^\/session\/[^/]+\/event$/u.test(path)) return "session";
  return "unknown";
}

interface TimedChunk {
  readonly atMs: number;
  readonly text: string;
}

function parseSsePayload(
  payload: string,
  raw: string,
  receivedAtMs: number
): NonNullable<CaptureRecord["sse"]>["frames"][number] {
  let event: string | null = null;
  let id: string | undefined;
  let retry: number | undefined;
  const comments: string[] = [];
  const data: string[] = [];
  for (const line of payload.split(/\r?\n/u)) {
    if (line.startsWith(":")) {
      comments.push(
        line.slice(1).startsWith(" ") ? line.slice(2) : line.slice(1)
      );
    } else if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    } else if (line.startsWith("id:")) {
      id = line.slice("id:".length).trimStart();
    } else if (line.startsWith("retry:")) {
      const parsedRetry = Number.parseInt(
        line.slice("retry:".length).trim(),
        10
      );
      if (Number.isSafeInteger(parsedRetry) && parsedRetry >= 0)
        retry = parsedRetry;
    }
  }
  const joined = data.join("\n");
  let parsed: JsonValue | undefined;
  try {
    parsed = JSON.parse(joined) as JsonValue;
  } catch {
    parsed = undefined;
  }
  return {
    comments,
    data: joined,
    event,
    ...(id === undefined ? {} : { id }),
    ...(parsed === undefined ? {} : { parsed }),
    receivedAtMs,
    ...(retry === undefined ? {} : { retry }),
    raw,
  };
}

function parseSseFrames(
  chunks: readonly TimedChunk[],
  path: string,
  redact: (value: string) => string
): NonNullable<CaptureRecord["sse"]> {
  const frames: Array<{
    data: string;
    event: string | null;
    id?: string;
    comments: readonly string[];
    parsed?: JsonValue;
    receivedAtMs: number;
    retry?: number;
    raw: string;
  }> = [];
  let buffer = "";
  for (const chunk of chunks) {
    buffer += chunk.text;
    while (true) {
      const lf = buffer.indexOf("\n\n");
      const crlf = buffer.indexOf("\r\n\r\n");
      const boundary = lf < 0 ? crlf : crlf < 0 ? lf : Math.min(lf, crlf);
      if (boundary < 0) break;
      const separatorLength = buffer.startsWith("\r\n", boundary + 2) ? 4 : 2;
      const raw = redact(buffer.slice(0, boundary + separatorLength));
      frames.push(
        parseSsePayload(
          redact(buffer.slice(0, boundary)),
          raw,
          Math.max(0, Math.round(chunk.atMs))
        )
      );
      buffer = buffer.slice(boundary + separatorLength);
    }
  }
  return {
    frames,
    ...(buffer.length === 0 ? {} : { remainder: redact(buffer) }),
    reconnect: 1,
    scope: sseScope(path),
  };
}

export class Redactor {
  private readonly replacements = new Map<string, string>();
  private nextReplacement = 1;

  redact(value: string): string {
    let result = value;
    const home = process.env.HOME;
    if (isString(home) && home.length > 0)
      result = result.replaceAll(home, "<HOME>");
    result = result.replace(
      /(?:Bearer\s+|Basic\s+)([A-Za-z0-9._~+/=-]{8,})/gu,
      (_match, secret: string) =>
        `${_match.slice(0, _match.indexOf(secret))}${this.replaceSecret(secret)}`
    );
    result = result.replace(
      /\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gu,
      (secret) => this.replaceSecret(secret)
    );
    return result;
  }

  redactHeaders(headers: Headers): Readonly<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const [name, value] of headers) {
      const lowerName = name.toLowerCase();
      result[name] = [
        "authorization",
        "cookie",
        "proxy-authorization",
        "set-cookie",
      ].includes(lowerName)
        ? this.replaceSecret(value)
        : this.redact(value);
    }
    return result;
  }

  private replaceSecret(value: string): string {
    const known = this.replacements.get(value);
    if (known !== undefined) return known;
    const replacement = `<REDACTED-${this.nextReplacement}>`;
    this.nextReplacement += 1;
    this.replacements.set(value, replacement);
    return replacement;
  }
}

export class CaptureStore {
  private sequence = 0;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly reconnects = new Map<string, number>();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly config: CaptureConfig,
    private readonly redactor = new Redactor()
  ) {}

  nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  nextReconnect(
    path: string,
    correlation: Readonly<Record<string, string>> | undefined
  ): number {
    const run = correlation?.["x-contract-run-id"] ?? "";
    const scenario = correlation?.["x-contract-scenario"] ?? "";
    const key = `${run}\u0000${scenario}\u0000${path}`;
    const reconnect = (this.reconnects.get(key) ?? 0) + 1;
    this.reconnects.set(key, reconnect);
    return reconnect;
  }

  redact(value: string): string {
    return this.redactor.redact(value);
  }

  redactHeaders(headers: Headers): Readonly<Record<string, string>> {
    return this.redactor.redactHeaders(headers);
  }

  async append(record: CaptureRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    this.writeTail = this.writeTail.then(async () => {
      await mkdir(dirname(this.config.output), { recursive: true });
      await appendFile(this.config.output, line, "utf8");
    });
    await this.writeTail;
  }

  track(promise: Promise<void>): void {
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise)
    );
  }

  async flush(): Promise<void> {
    while (true) {
      await this.writeTail;
      const pending = [...this.pending];
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }
}

export function requestHeadersForUpstream(headers: Headers): Headers {
  const result = new Headers();
  for (const [name, value] of headers) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) result.set(name, value);
  }
  return result;
}

export function makeCaptureConfig(
  target: string,
  output: string,
  maxBodyBytes = 8 * 1024 * 1024,
  runId: string = crypto.randomUUID()
): CaptureConfig {
  const parsedTarget = new URL(target);
  if (parsedTarget.protocol !== "http:" && parsedTarget.protocol !== "https:") {
    throw new Error("Capture target must use http or https.");
  }
  if (maxBodyBytes < 1 || !Number.isSafeInteger(maxBodyBytes)) {
    throw new Error("Capture max body bytes must be a positive safe integer.");
  }
  return { maxBodyBytes, output, runId, target: parsedTarget };
}

export function createCaptureHandler(
  config: CaptureConfig,
  store = new CaptureStore(config)
): {
  readonly handler: (request: Request) => Promise<Response>;
  readonly store: CaptureStore;
} {
  const handler = async (request: Request): Promise<Response> => {
    const started = performance.now();
    const startedAt = new Date().toISOString();
    const sequence = store.nextSequence();
    const requestURL = new URL(request.url);
    const requestBytes = new Uint8Array(await request.clone().arrayBuffer());
    const requestBody = bodyText(requestBytes, config.maxBodyBytes);
    const suppliedCorrelation = correlationHeaders(request.headers);
    const correlation = {
      "x-contract-run-id":
        suppliedCorrelation?.["x-contract-run-id"] ?? config.runId,
      "x-contract-scenario":
        suppliedCorrelation?.["x-contract-scenario"] ?? "unknown",
      ...suppliedCorrelation,
    };
    const reconnect = store.nextReconnect(requestURL.pathname, correlation);
    const upstreamRequest: RequestInit = {
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : requestBytes,
      headers: requestHeadersForUpstream(request.headers),
      method: request.method,
      redirect: "manual",
      signal: request.signal,
    };
    const baseRecord = {
      body: {
        request: store.redact(requestBody.text),
        requestTruncated: requestBody.truncated,
        response: null,
        responseTruncated: false,
      },
      durationMs: 0,
      request: {
        headers: store.redactHeaders(request.headers),
        method: request.method,
        path: requestURL.pathname,
        query: queryRecord(requestURL),
      },
      sequence,
      startedAt,
      connection: { reason: "transport-error", state: "error" },
      correlation,
    } satisfies CaptureRecord;

    try {
      const upstream = await fetch(
        targetURL(config.target, requestURL),
        upstreamRequest
      );
      const [clientBody, recordBody] = upstream.body?.tee() ?? [null, null];
      const response = new Response(clientBody, {
        headers: upstream.headers,
        status: upstream.status,
        statusText: upstream.statusText,
      });
      const capturePromise = recordResponse(
        config,
        store,
        baseRecord,
        upstream,
        recordBody,
        request.signal,
        reconnect,
        started
      ).catch(async (error: unknown) => {
        await store.append({
          ...baseRecord,
          durationMs: Math.round(performance.now() - started),
          response: {
            headers: store.redactHeaders(upstream.headers),
            status: upstream.status,
          },
          connection: {
            reason: request.signal.aborted
              ? "client-cancelled"
              : "transport-error",
            state: "error",
          },
          transportError:
            error instanceof Error ? error.message : "response capture failed",
        });
      });
      store.track(capturePromise);
      return response;
    } catch (error) {
      const record: CaptureRecord = {
        ...baseRecord,
        durationMs: Math.round(performance.now() - started),
        connection: {
          reason: request.signal.aborted
            ? "client-cancelled"
            : "transport-error",
          state: "error",
        },
        transportError:
          error instanceof Error ? error.message : "upstream request failed",
      };
      await store.append(record);
      return Response.json(
        {
          error: {
            code: "capture_upstream_failed",
            message: "Upstream request failed.",
          },
        },
        { status: 502 }
      );
    }
  };
  return { handler, store };
}

async function recordResponse(
  config: CaptureConfig,
  store: CaptureStore,
  baseRecord: CaptureRecord,
  upstream: Response,
  body: ReadableStream<Uint8Array> | null,
  requestSignal: AbortSignal,
  reconnect: number,
  started: number
): Promise<void> {
  let responseBytes = new Uint8Array();
  let responseTruncated = false;
  const timedChunks: TimedChunk[] = [];
  if (body !== null) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value === undefined) continue;
      const receivedAtMs = performance.now() - started;
      const remaining = config.maxBodyBytes - totalBytes;
      if (remaining > 0) {
        const visible = next.value.subarray(0, remaining);
        chunks.push(visible);
        if (visible.byteLength > 0)
          timedChunks.push({ atMs: receivedAtMs, text: "" });
        if (visible.byteLength < next.value.byteLength)
          responseTruncated = true;
      } else {
        responseTruncated = true;
      }
      totalBytes += next.value.byteLength;
    }
    responseBytes = new Uint8Array(Math.min(totalBytes, config.maxBodyBytes));
    let offset = 0;
    for (const chunk of chunks) {
      const visible = chunk.subarray(0, responseBytes.byteLength - offset);
      responseBytes.set(visible, offset);
      offset += visible.byteLength;
      if (offset >= responseBytes.byteLength) break;
    }
    const decoder = new TextDecoder();
    for (const [index, chunk] of chunks.entries()) {
      const timed = timedChunks[index];
      if (timed !== undefined)
        timedChunks[index] = {
          atMs: timed.atMs,
          text: decoder.decode(chunk, { stream: true }),
        };
    }
    const tail = decoder.decode();
    if (tail.length > 0) {
      const last = timedChunks.at(-1);
      if (last === undefined) timedChunks.push({ atMs: 0, text: tail });
      else
        timedChunks[timedChunks.length - 1] = {
          atMs: last.atMs,
          text: last.text + tail,
        };
    }
  }
  const responseBody = bodyText(responseBytes, config.maxBodyBytes);
  const redactedResponse = store.redact(responseBody.text);
  const contentType = upstream.headers.get("content-type") ?? "";
  const record: CaptureRecord = {
    ...baseRecord,
    body: {
      ...baseRecord.body,
      response: redactedResponse,
      responseTruncated: responseBody.truncated || responseTruncated,
    },
    connection: {
      closedAt: new Date().toISOString(),
      reason: requestSignal.aborted
        ? "client-cancelled"
        : contentType.includes("text/event-stream")
          ? "server-closed"
          : "normal",
      state: "closed",
    },
    durationMs: Math.round(performance.now() - started),
    response: {
      headers: store.redactHeaders(upstream.headers),
      status: upstream.status,
    },
    ...(contentType.includes("text/event-stream")
      ? {
          sse: {
            ...parseSseFrames(timedChunks, baseRecord.request.path, (value) =>
              store.redact(value)
            ),
            reconnect,
          },
        }
      : {}),
  };
  await store.append(record);
}
