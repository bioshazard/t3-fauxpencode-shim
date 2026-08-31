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

interface SseResult {
  readonly eventTypes: readonly string[];
  readonly terminal: boolean;
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

function bodyAssistantId(body: string | null): string | null {
  if (body === null) return null;
  const parsed = parsedBody(body);
  if (!Array.isArray(parsed)) return null;
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const info = item.info;
    if (!isRecord(info) || info.role !== "assistant") continue;
    const id = info.id;
    if (Object.prototype.toString.call(id) === "[object String]")
      return String(id);
  }
  return null;
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown
): Promise<OperationResult> {
  try {
    const serializedBody =
      Object.prototype.toString.call(body) === "[object String]"
        ? String(body)
        : body === undefined
          ? undefined
          : JSON.stringify(body);
    const response = await fetch(new URL(path, baseUrl), {
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
      headers:
        serializedBody === undefined
          ? {}
          : { "content-type": "application/json" },
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
  return (
    properties.sessionStatus === "idle" ||
    properties.status === "idle" ||
    properties.sessionStatus === "aborted" ||
    properties.status === "aborted" ||
    properties.sessionStatus === "error" ||
    properties.status === "error"
  );
}

interface OpenSse {
  readonly done: Promise<SseResult>;
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
    if (response.body === null) return { eventTypes: [], terminal: false };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const types: string[] = [];
    let terminal = false;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        let boundary = frameBoundary(buffer);
        while (boundary >= 0) {
          const frame = parseFrame(buffer.slice(0, boundary));
          const separatorLength = buffer.startsWith("\r\n", boundary + 2)
            ? 4
            : 2;
          buffer = buffer.slice(boundary + separatorLength);
          if (frame !== null) {
            const type = eventType(frame);
            if (type !== null) types.push(type);
            if (isTerminalFrame(frame)) {
              terminal = true;
              controller.abort();
              return { eventTypes: types, terminal };
            }
          }
          boundary = frameBoundary(buffer);
        }
      }
      return { eventTypes: types, terminal };
    } finally {
      clearTimeout(timer);
    }
  })().catch((error: unknown) => {
    rejectReady(error);
    if (error instanceof DOMException && error.name === "AbortError") {
      return { eventTypes: [], terminal: false };
    }
    throw error;
  });
  return { done, ready, stop: () => controller.abort() };
}

function frameBoundary(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0) return crlf;
  if (crlf < 0) return lf;
  return Math.min(lf, crlf);
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
  results.push({
    expectedTerminal: "empty history response received",
    id: "C05",
    observedEventTypes: [],
    operations: [await call(baseUrl, "GET", `${sessionPath}/message`)],
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
    const sse = await stream.done;
    const observedEventTypes = sse.eventTypes;
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

  const populatedHistory = await call(baseUrl, "GET", `${sessionPath}/message`);
  const assistantId = bodyAssistantId(populatedHistory.body);
  const revert = await call(baseUrl, "POST", `${sessionPath}/revert`, {
    messageID: assistantId ?? "missing-assistant",
  });
  results.push({
    expectedTerminal: "completed turn can be reverted",
    id: "C13",
    observedEventTypes: [],
    operations: [
      populatedHistory,
      revert,
      await call(baseUrl, "GET", `${sessionPath}/message`),
    ],
    sessionId,
  });

  const continuedStream = openSse(baseUrl, timeoutMs);
  try {
    await continuedStream.ready;
    const continuedPrompt = await call(
      baseUrl,
      "POST",
      `${sessionPath}/prompt_async`,
      { parts: [{ text: "after rollback", type: "text" }] }
    );
    const continuedEvents = await continuedStream.done;
    results.push({
      expectedTerminal: "a reverted session accepts a new turn",
      id: "C14",
      observedEventTypes: continuedEvents.eventTypes,
      operations: [
        continuedPrompt,
        await call(baseUrl, "GET", `${sessionPath}/message`),
      ],
      sessionId,
    });
  } catch (error) {
    continuedStream.stop();
    results.push({
      expectedTerminal: "a reverted session accepts a new turn",
      id: "C14",
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

  const abortStream = openSse(baseUrl, timeoutMs);
  try {
    await abortStream.ready;
    const prompt = call(baseUrl, "POST", `${sessionPath}/prompt_async`, {
      parts: [{ text: "abort me", type: "text" }],
    });
    const abort = await call(baseUrl, "POST", `${sessionPath}/abort`);
    const promptResult = await prompt;
    const abortEvents = await abortStream.done;
    results.push({
      expectedTerminal: "active turn abort returns and closes the stream",
      id: "C11",
      observedEventTypes: abortEvents.eventTypes,
      operations: [promptResult, abort],
      sessionId,
    });
  } catch (error) {
    abortStream.stop();
    results.push({
      expectedTerminal: "active turn abort returns and closes the stream",
      id: "C11",
      observedEventTypes: [],
      operations: [
        {
          body: null,
          method: "POST",
          path: `${sessionPath}/abort`,
          status: null,
          transportError:
            error instanceof Error ? error.message : "abort capture failed",
        },
      ],
      sessionId,
    });
  }

  const malformed = await call(baseUrl, "POST", "/session", "not-json");
  const missing = await call(baseUrl, "POST", "/session/missing/prompt_async", {
    parts: [{ text: "missing", type: "text" }],
  });
  results.push({
    expectedTerminal: "malformed and unknown-session requests return errors",
    id: "C18",
    observedEventTypes: [],
    operations: [malformed, missing],
    sessionId,
  });

  const secondCreate = await call(baseUrl, "POST", "/session", {});
  const secondId = bodySessionId(secondCreate.body);
  if (secondId !== null) {
    const firstStream = openSse(baseUrl, timeoutMs);
    const secondStream = openSse(baseUrl, timeoutMs);
    try {
      await Promise.all([firstStream.ready, secondStream.ready]);
      const [firstPrompt, secondPrompt] = await Promise.all([
        call(baseUrl, "POST", `${sessionPath}/prompt_async`, {
          parts: [{ text: "parallel one", type: "text" }],
        }),
        call(
          baseUrl,
          "POST",
          `/session/${encodeURIComponent(secondId)}/prompt_async`,
          {
            parts: [{ text: "parallel two", type: "text" }],
          }
        ),
      ]);
      const [firstEvents, secondEvents] = await Promise.all([
        firstStream.done,
        secondStream.done,
      ]);
      results.push({
        expectedTerminal: "two sessions complete without event leakage",
        id: "C17",
        observedEventTypes: [
          ...firstEvents.eventTypes,
          ...secondEvents.eventTypes,
        ],
        operations: [secondCreate, firstPrompt, secondPrompt],
        sessionId,
      });
    } catch (error) {
      firstStream.stop();
      secondStream.stop();
      results.push({
        expectedTerminal: "two sessions complete without event leakage",
        id: "C17",
        observedEventTypes: [],
        operations: [
          {
            body: null,
            method: "POST",
            path: "/session/{sessionID}/prompt_async",
            status: null,
            transportError:
              error instanceof Error
                ? error.message
                : "concurrency capture failed",
          },
        ],
        sessionId,
      });
    }
  } else {
    results.push({
      expectedTerminal: "two sessions complete without event leakage",
      id: "C17",
      observedEventTypes: [],
      operations: [secondCreate],
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
        scenario.id === "C06" &&
        scenario.observedEventTypes.includes("turn.completed")
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
