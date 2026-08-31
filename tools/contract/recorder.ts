import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface CaptureConfig {
  readonly maxBodyBytes: number;
  readonly output: string;
  readonly target: URL;
}

export interface CaptureRecord {
  readonly body: {
    readonly request: string | null;
    readonly requestTruncated: boolean;
    readonly response: string | null;
    readonly responseTruncated: boolean;
  };
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

  constructor(
    private readonly config: CaptureConfig,
    private readonly redactor = new Redactor()
  ) {}

  nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
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

  async flush(): Promise<void> {
    await this.writeTail;
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
  maxBodyBytes = 8 * 1024 * 1024
): CaptureConfig {
  const parsedTarget = new URL(target);
  if (parsedTarget.protocol !== "http:" && parsedTarget.protocol !== "https:") {
    throw new Error("Capture target must use http or https.");
  }
  if (maxBodyBytes < 1 || !Number.isSafeInteger(maxBodyBytes)) {
    throw new Error("Capture max body bytes must be a positive safe integer.");
  }
  return { maxBodyBytes, output, target: parsedTarget };
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
      void recordResponse(
        config,
        store,
        baseRecord,
        upstream,
        recordBody,
        started
      );
      return response;
    } catch (error) {
      const record: CaptureRecord = {
        ...baseRecord,
        durationMs: Math.round(performance.now() - started),
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
  started: number
): Promise<void> {
  let responseBytes = new Uint8Array();
  let responseTruncated = false;
  if (body !== null) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value === undefined) continue;
      const remaining = config.maxBodyBytes - totalBytes;
      if (remaining > 0) {
        const visible = next.value.subarray(0, remaining);
        chunks.push(visible);
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
  }
  const responseBody = bodyText(responseBytes, config.maxBodyBytes);
  const record: CaptureRecord = {
    ...baseRecord,
    body: {
      ...baseRecord.body,
      response: store.redact(responseBody.text),
      responseTruncated: responseBody.truncated || responseTruncated,
    },
    durationMs: Math.round(performance.now() - started),
    response: {
      headers: store.redactHeaders(upstream.headers),
      status: upstream.status,
    },
  };
  await store.append(record);
}
