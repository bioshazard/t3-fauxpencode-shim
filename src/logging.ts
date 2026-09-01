const MAX_BODY_CHARS = 16_384;
const SENSITIVE_KEY =
  /(?:authorization|cookie|password|secret|token|api[-_]?key)/iu;
const CONTENT_KEY = /(?:^data$|^text$|^prompt$)/iu;

export interface RequestLogEntry {
  readonly body?: unknown;
  readonly bodyTruncated?: true;
  readonly contentLength?: string;
  readonly contentType?: string;
  readonly durationMs: number;
  readonly error?: string;
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, readonly string[]>>;
  readonly requestId: string;
  readonly status?: number;
  readonly type: "http.request";
  readonly userAgent?: string;
}

export type RequestLogSink = (entry: RequestLogEntry) => void;

function redact(value: unknown, key?: string): unknown {
  if (key !== undefined && (SENSITIVE_KEY.test(key) || CONTENT_KEY.test(key))) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (Object.prototype.toString.call(value) === "[object Object]") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey)]
      )
    );
  }
  return value;
}

async function requestBody(
  request: Request
): Promise<Pick<RequestLogEntry, "body" | "bodyTruncated">> {
  if (request.body === null) return {};
  const reader = request.clone().body?.getReader();
  if (reader === undefined) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  while (!truncated) {
    const next = await reader.read();
    if (next.done) break;
    const remaining = MAX_BODY_CHARS - size;
    if (next.value.byteLength > remaining) {
      chunks.push(next.value.slice(0, remaining));
      truncated = true;
      void reader.cancel();
    } else {
      chunks.push(next.value);
      size += next.value.byteLength;
    }
  }
  const sample = new TextDecoder().decode(
    Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))
  );
  try {
    return {
      body: redact(JSON.parse(sample)),
      ...(truncated ? { bodyTruncated: true as const } : {}),
    };
  } catch {
    return {
      body: "[NON_JSON_BODY]",
      ...(truncated ? { bodyTruncated: true as const } : {}),
    };
  }
}

function queryEntries(url: URL): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    [...new Set(url.searchParams.keys())].map((key) => [
      key,
      url.searchParams.getAll(key),
    ])
  );
}

export function createRequestLogger(sink: RequestLogSink = console.log): {
  readonly log: (
    request: Request,
    response: Promise<Response>,
    startedAt: number
  ) => void;
} {
  return {
    log(request, response, startedAt) {
      const url = new URL(request.url);
      const body = requestBody(request).catch(() => ({}));
      void response.then(
        async (result) => {
          sink({
            ...(await body),
            ...(request.headers.get("content-length") === null
              ? {}
              : {
                  contentLength:
                    request.headers.get("content-length") ?? undefined,
                }),
            ...(request.headers.get("content-type") === null
              ? {}
              : {
                  contentType: request.headers.get("content-type") ?? undefined,
                }),
            durationMs: Math.round(performance.now() - startedAt),
            method: request.method,
            path: url.pathname,
            query: queryEntries(url),
            requestId: crypto.randomUUID(),
            status: result.status,
            type: "http.request",
            ...(request.headers.get("user-agent") === null
              ? {}
              : { userAgent: request.headers.get("user-agent") ?? undefined }),
          });
        },
        (cause: unknown) => {
          sink({
            durationMs: Math.round(performance.now() - startedAt),
            error:
              cause instanceof Error
                ? cause.message
                : "Unhandled request failure.",
            method: request.method,
            path: url.pathname,
            query: queryEntries(url),
            requestId: crypto.randomUUID(),
            type: "http.request",
          });
        }
      );
    },
  };
}
