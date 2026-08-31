import { Redactor } from "./recorder.ts";

interface OperationResult {
  readonly body: string | null;
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly transportError?: string;
}

interface ScenarioResult {
  readonly expectedTerminal: string;
  readonly id: string;
  readonly operations: readonly OperationResult[];
  readonly observedEventTypes: readonly string[];
  readonly sessionId?: string;
}

interface ScenarioReport {
  readonly baseUrl: string;
  readonly corpusId: string | null;
  readonly generatedAt: string;
  readonly scenarios: readonly ScenarioResult[];
  readonly status: "completed" | "partial";
}

interface SseFrame {
  readonly data: string;
  readonly event: string | null;
}

const redactor = new Redactor();

function isRecord(
  value: unknown
): value is { readonly [key: string]: unknown } {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function parsedBody(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function bodySessionId(body: string | null): string | null {
  if (body === null) return null;
  const parsed = parsedBody(body);
  if (!isRecord(parsed)) return null;
  const id = parsed.id;
  return Object.prototype.toString.call(id) === "[object String]" &&
    String(id).length > 0
    ? String(id)
    : null;
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown
): Promise<OperationResult> {
  try {
    const response = await fetch(new URL(path, baseUrl), {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: body === undefined ? {} : { "content-type": "application/json" },
      method,
    });
    const text = await response.text();
    return {
      body: redactor.redact(text),
      method,
      path,
      status: response.status,
    };
  } catch (error) {
    return {
      body: null,
      method,
      path,
      status: null,
      transportError: error instanceof Error ? error.message : "request failed",
    };
  }
}

function parseFrame(frame: string): SseFrame | null {
  const lines = frame.split("\n");
  let event: string | null = null;
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    if (line.startsWith("data:"))
      data.push(line.slice("data:".length).trimStart());
  }
  return event === null && data.length === 0
    ? null
    : { data: data.join("\n"), event };
}

function eventType(frame: SseFrame): string | null {
  if (frame.event !== null) return frame.event;
  const parsed = parsedBody(frame.data);
  if (!isRecord(parsed)) return null;
  const type = parsed.type;
  return Object.prototype.toString.call(type) === "[object String]"
    ? String(type)
    : null;
}

function isTerminalFrame(frame: SseFrame): boolean {
  const type = eventType(frame);
  if (type === "turn.completed") return true;
  if (type !== "session.status") return false;
  const parsed = parsedBody(frame.data);
  if (!isRecord(parsed)) return false;
  const properties = parsed.properties;
  if (!isRecord(properties)) return false;
  return properties.sessionStatus === "idle" || properties.status === "idle";
}

interface OpenSse {
  readonly done: Promise<readonly string[]>;
  readonly ready: Promise<Response>;
  readonly stop: () => void;
}

function openSse(baseUrl: string, timeoutMs: number): OpenSse {
  const controller = new AbortController();
  let resolveReady: (response: Response) => void = () => undefined;
  let rejectReady: (error: unknown) => void = () => undefined;
  const ready = new Promise<Response>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const done = (async () => {
    const response = await fetch(new URL("/event", baseUrl), {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    resolveReady(response);
    if (response.body === null) return [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const types: string[] = [];
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = parseFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (frame !== null) {
            const type = eventType(frame);
            if (type !== null) types.push(type);
            if (isTerminalFrame(frame)) {
              controller.abort();
              return types;
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
      return types;
    } finally {
      clearTimeout(timer);
    }
  })().catch((error: unknown) => {
    rejectReady(error);
    if (error instanceof DOMException && error.name === "AbortError") return [];
    throw error;
  });
  return { done, ready, stop: () => controller.abort() };
}

export async function runScenarios(
  baseUrl: string,
  corpusId: string | null,
  timeoutMs = 15_000
): Promise<ScenarioReport> {
  const results: ScenarioResult[] = [];
  const startup: OperationResult[] = [];
  startup.push(await call(baseUrl, "GET", "/global/health"));
  results.push({
    expectedTerminal: "health response received",
    id: "C01",
    observedEventTypes: [],
    operations: startup,
  });

  const discovery: OperationResult[] = [];
  for (const path of ["/provider", "/agent", "/skill"]) {
    discovery.push(await call(baseUrl, "GET", path));
  }
  results.push({
    expectedTerminal: "provider, agent, and skill responses received",
    id: "C02",
    observedEventTypes: [],
    operations: discovery,
  });

  const create = await call(baseUrl, "POST", "/session", {});
  const sessionId = bodySessionId(create.body);
  results.push({
    expectedTerminal: "session id returned",
    id: "C03",
    observedEventTypes: [],
    operations: [create],
    ...(sessionId === null ? {} : { sessionId }),
  });
  if (sessionId === null) {
    return {
      baseUrl,
      corpusId,
      generatedAt: new Date().toISOString(),
      scenarios: results,
      status: "partial",
    };
  }

  const sessionPath = `/session/${encodeURIComponent(sessionId)}`;
  results.push({
    expectedTerminal: "session and history can be reconstructed",
    id: "C04",
    observedEventTypes: [],
    operations: [
      await call(baseUrl, "GET", sessionPath),
      await call(baseUrl, "GET", `${sessionPath}/message`),
    ],
    sessionId,
  });

  const stream = openSse(baseUrl, timeoutMs);
  try {
    await stream.ready;
    const prompt = await call(baseUrl, "POST", `${sessionPath}/prompt_async`, {
      parts: [
        {
          text: Bun.env.CAPTURE_PROMPT ?? "contract capture text",
          type: "text",
        },
      ],
    });
    const observedEventTypes = await stream.done;
    results.push({
      expectedTerminal: "prompt response plus terminal SSE event",
      id: "C06",
      observedEventTypes,
      operations: [prompt],
      sessionId,
    });
  } catch (error) {
    stream.stop();
    results.push({
      expectedTerminal: "prompt response plus terminal SSE event",
      id: "C06",
      observedEventTypes: [],
      operations: [
        {
          body: null,
          method: "POST",
          path: `${sessionPath}/prompt_async`,
          status: null,
          transportError:
            error instanceof Error ? error.message : "SSE capture failed",
        },
      ],
      sessionId,
    });
  }
  return {
    baseUrl,
    corpusId,
    generatedAt: new Date().toISOString(),
    scenarios: results,
    status: results.some(
      (scenario) =>
        scenario.id === "C06" && scenario.observedEventTypes.length > 0
    )
      ? "completed"
      : "partial",
  };
}

if (import.meta.main) {
  const baseUrl = Bun.env.CAPTURE_TARGET ?? Bun.env.SCENARIO_TARGET;
  if (baseUrl === undefined || baseUrl.trim().length === 0) {
    throw new Error("CAPTURE_TARGET or SCENARIO_TARGET is required.");
  }
  const output = Bun.env.SCENARIO_OUTPUT ?? "artifacts/runs/latest.json";
  const corpusId = Bun.env.CORPUS_ID ?? null;
  const report = await runScenarios(baseUrl, corpusId);
  await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`scenario run ${report.status}; wrote ${output}`);
}
