import { Redactor } from "./recorder.ts";
import { REQUIRED_REFERENCE_SCENARIOS } from "./reference-artifacts.ts";

interface OperationResult {
  readonly body: string | null;
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly transportError?: string;
}

export interface ScenarioResult {
  readonly applicability: "required" | "not-applicable";
  readonly canonicalState: unknown;
  readonly declaredState: unknown;
  readonly expectedTerminal: string;
  readonly failures: readonly string[];
  readonly id: string;
  readonly operations: readonly OperationResult[];
  readonly observedEventTypes: readonly string[];
  readonly passed: boolean;
  readonly sessionId?: string;
  readonly skipReason?: string;
}

type ScenarioResultInput = Omit<
  ScenarioResult,
  "applicability" | "canonicalState" | "declaredState" | "failures" | "passed"
> & {
  readonly applicability?: "required" | "not-applicable";
  readonly canonicalState?: unknown;
  readonly declaredState?: unknown;
  readonly abortValid?: boolean;
  readonly barrierValid?: boolean;
  readonly scopeValid?: boolean;
};

export interface ScenarioReport {
  readonly baseUrl: string;
  readonly corpusId: string | null;
  readonly generatedAt: string;
  readonly runId: string;
  readonly scenarios: readonly ScenarioResult[];
  readonly status: "completed" | "partial";
}

interface SseFrame {
  readonly data: string;
  readonly event: string | null;
}

interface SseResult {
  readonly eventTypes: readonly string[];
  readonly sessionIDs: readonly string[];
  readonly terminalStatuses: readonly string[];
  readonly terminal: boolean;
}

export interface ScenarioBarrier {
  readonly waitFor: (name: string) => Promise<boolean>;
}

export interface ScenarioOptions {
  readonly barrier?: ScenarioBarrier;
  readonly runId?: string;
}

const SCENARIO_IDS = REQUIRED_REFERENCE_SCENARIOS;

interface RequestContext {
  readonly runId: string;
  readonly scenario: string;
  readonly sessionId?: string;
  readonly turnId?: string;
}

const redactor = new Redactor();

function isRecord(
  value: unknown
): value is { readonly [key: string]: unknown } {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isStringValue(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isFunctionValue(value: unknown): value is (value: number) => boolean {
  return Object.prototype.toString.call(value) === "[object Function]";
}

function parsedBody(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function operationBody(operation: OperationResult | undefined): unknown {
  return operation?.body === null || operation?.body === undefined
    ? undefined
    : parsedBody(operation.body);
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
  body?: unknown,
  context?: RequestContext
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
      headers: {
        ...(serializedBody === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(context === undefined
          ? {}
          : {
              "x-contract-run-id": context.runId,
              "x-contract-scenario": context.scenario,
              ...(context.sessionId === undefined
                ? {}
                : { "x-opencode-session-id": context.sessionId }),
              ...(context.turnId === undefined
                ? {}
                : { "x-t3-turn-id": context.turnId }),
            }),
      },
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

function openSse(
  baseUrl: string,
  path: string,
  timeoutMs: number,
  context: RequestContext
): OpenSse {
  const controller = new AbortController();
  let resolveReady: (response: Response) => void = () => undefined;
  let rejectReady: (error: unknown) => void = () => undefined;
  const ready = new Promise<Response>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const done = (async () => {
    const response = await fetch(new URL(path, baseUrl), {
      headers: {
        accept: "text/event-stream",
        "x-contract-run-id": context.runId,
        "x-contract-scenario": context.scenario,
        ...(context.sessionId === undefined
          ? {}
          : { "x-opencode-session-id": context.sessionId }),
        ...(context.turnId === undefined
          ? {}
          : { "x-t3-turn-id": context.turnId }),
      },
      signal: controller.signal,
    });
    resolveReady(response);
    if (response.body === null)
      return {
        eventTypes: [],
        sessionIDs: [],
        terminalStatuses: [],
        terminal: false,
      };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const types: string[] = [];
    const sessionIDs = new Set<string>();
    const terminalStatuses = new Set<string>();
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
            const parsed = parsedBody(frame.data);
            if (isRecord(parsed) && isStringValue(parsed.sessionID))
              sessionIDs.add(parsed.sessionID);
            if (isRecord(parsed) && isRecord(parsed.properties)) {
              const status =
                parsed.properties.sessionStatus ?? parsed.properties.status;
              if (isStringValue(status)) terminalStatuses.add(status);
            }
            if (isTerminalFrame(frame)) {
              terminal = true;
              controller.abort();
              return {
                eventTypes: types,
                sessionIDs: [...sessionIDs],
                terminalStatuses: [...terminalStatuses],
                terminal,
              };
            }
          }
          boundary = frameBoundary(buffer);
        }
      }
      return {
        eventTypes: types,
        sessionIDs: [...sessionIDs],
        terminalStatuses: [...terminalStatuses],
        terminal,
      };
    } finally {
      clearTimeout(timer);
    }
  })().catch((error: unknown) => {
    rejectReady(error);
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        eventTypes: [],
        sessionIDs: [],
        terminalStatuses: [],
        terminal: false,
      };
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

function expectedStatusFailure(
  scenario: ScenarioResultInput,
  index: number,
  expected: number | readonly number[] | ((status: number) => boolean)
): string | null {
  const operation = scenario.operations[index];
  if (operation === undefined) return `missing operation ${index + 1}`;
  if (operation.status === null)
    return `${operation.method} ${operation.path} did not receive a response`;
  const matches = isFunctionValue(expected)
    ? expected(operation.status)
    : Array.isArray(expected)
      ? expected.includes(operation.status)
      : operation.status === expected;
  return matches
    ? null
    : `${operation.method} ${operation.path} returned ${operation.status}`;
}

function finalizeScenarios(
  results: readonly ScenarioResultInput[],
  barriersAvailable: boolean
): readonly ScenarioResult[] {
  const finalized = results.map((scenario) => {
    const failures: string[] = [];
    const any2xx = (status: number): boolean => status >= 200 && status < 300;
    const check = (
      index: number,
      expected: number | readonly number[] | ((status: number) => boolean)
    ): void => {
      const failure = expectedStatusFailure(scenario, index, expected);
      if (failure !== null) failures.push(failure);
    };
    switch (scenario.id) {
      case "C01":
        check(0, 200);
        break;
      case "C02":
        scenario.operations.forEach((_operation, index) => check(index, 200));
        break;
      case "C03":
        check(0, any2xx);
        break;
      case "C04":
        check(0, 200);
        check(1, 200);
        check(2, 200);
        check(3, 404);
        if (!Array.isArray(operationBody(scenario.operations[0])))
          failures.push("session list response is not an array");
        if (!Array.isArray(operationBody(scenario.operations[2])))
          failures.push("history response is not an array");
        break;
      case "C05":
        scenario.operations.forEach((_operation, index) => check(index, 200));
        if (
          !Array.isArray(operationBody(scenario.operations[0])) ||
          (operationBody(scenario.operations[0]) as readonly unknown[])
            .length !== 0
        )
          failures.push("empty history observation was not empty");
        if (
          !Array.isArray(operationBody(scenario.operations[1])) ||
          (operationBody(scenario.operations[1]) as readonly unknown[])
            .length === 0
        )
          failures.push("populated history observation was empty");
        break;
      case "C06":
        check(0, 204);
        check(1, 200);
        if (!scenario.observedEventTypes.includes("turn.completed"))
          failures.push("no turn.completed event observed");
        if (!Array.isArray(operationBody(scenario.operations[1])))
          failures.push("final history response is not an array");
        break;
      case "C11":
        check(0, 204);
        check(1, 200);
        check(2, 200);
        if (!barriersAvailable) failures.push("C11 barrier was not provided");
        if (scenario.barrierValid !== true)
          failures.push("C11 barrier did not prove an active turn");
        if (scenario.abortValid !== true)
          failures.push("abort-specific terminal status was not observed");
        if (!Array.isArray(operationBody(scenario.operations[2])))
          failures.push("post-abort history response is not an array");
        break;
      case "C13":
        check(0, 200);
        check(1, 200);
        check(2, 200);
        if (!Array.isArray(operationBody(scenario.operations[0])))
          failures.push("pre-revert history response is not an array");
        if (!isRecord(operationBody(scenario.operations[1])))
          failures.push("revert response is not an object");
        if (!Array.isArray(operationBody(scenario.operations[2])))
          failures.push("post-revert history response is not an array");
        break;
      case "C14":
        check(0, 204);
        check(1, 200);
        if (!scenario.observedEventTypes.includes("turn.completed"))
          failures.push("no post-rollback completion event observed");
        const history = operationBody(scenario.operations[1]);
        if (!Array.isArray(history))
          failures.push("post-rollback history response is not an array");
        else if (history.length === 0)
          failures.push("post-rollback history response was empty");
        break;
      case "C17":
        scenario.operations.forEach((_operation, index) =>
          check(index, any2xx)
        );
        if (scenario.scopeValid !== true)
          failures.push("session-scoped event stream leaked another session");
        break;
      case "C18":
        check(0, 400);
        check(1, 404);
        break;
      default:
        break;
    }
    const {
      abortValid: _abortValid,
      barrierValid: _barrierValid,
      scopeValid: _scopeValid,
      ...publicScenario
    } = scenario;
    return {
      ...publicScenario,
      applicability: scenario.applicability ?? "required",
      canonicalState: scenario.canonicalState ?? {
        source: "scenario-runner-derived",
        value: operationBody(scenario.operations.at(-1)) ?? null,
      },
      declaredState: scenario.declaredState ?? {
        source: "scenario-runner-derived",
        scenario: scenario.id,
        sessionId: scenario.sessionId ?? null,
      },
      failures,
      passed: failures.length === 0,
    };
  });

  const observed = new Set(finalized.map((scenario) => scenario.id));
  const notApplicable = SCENARIO_IDS.filter((id) => !observed.has(id)).map(
    (id): ScenarioResult => ({
      applicability: "not-applicable",
      canonicalState: { source: "not-applicable" },
      declaredState: { source: "scenario-runner", scenario: id },
      expectedTerminal: "scenario is not applicable to the current driver",
      failures: [],
      id,
      observedEventTypes: [],
      operations: [],
      passed: true,
      skipReason:
        "The local raw-fetch driver does not exercise this stock-T3 scenario.",
    })
  );
  return [...finalized, ...notApplicable];
}

export async function runScenarios(
  baseUrl: string,
  corpusId: string | null,
  timeoutMs = 15_000,
  options: ScenarioOptions = {}
): Promise<ScenarioReport> {
  const results: ScenarioResultInput[] = [];
  const runId = options.runId ?? crypto.randomUUID();
  const barrier = options.barrier;
  const context = (
    scenario: string,
    sessionId?: string,
    turnId?: string
  ): RequestContext => ({
    runId,
    scenario,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(turnId === undefined ? {} : { turnId }),
  });
  const startup: OperationResult[] = [];
  startup.push(
    await call(baseUrl, "GET", "/global/health", undefined, context("C01"))
  );
  results.push({
    expectedTerminal: "health response received",
    id: "C01",
    observedEventTypes: [],
    operations: startup,
  });

  const discovery: OperationResult[] = [];
  for (const path of ["/provider", "/agent", "/skill"]) {
    discovery.push(await call(baseUrl, "GET", path, undefined, context("C02")));
  }
  results.push({
    expectedTerminal: "provider, agent, and skill responses received",
    id: "C02",
    observedEventTypes: [],
    operations: discovery,
  });

  const create = await call(baseUrl, "POST", "/session", {}, context("C03"));
  const sessionId = bodySessionId(create.body);
  results.push({
    expectedTerminal: "session id returned",
    id: "C03",
    observedEventTypes: [],
    operations: [create],
    ...(sessionId === null ? {} : { sessionId }),
  });
  if (sessionId === null) {
    const scenarios = finalizeScenarios(results, barrier !== undefined);
    return {
      baseUrl,
      corpusId,
      generatedAt: new Date().toISOString(),
      runId,
      scenarios,
      status: "partial",
    };
  }

  const sessionPath = `/session/${encodeURIComponent(sessionId)}`;
  results.push({
    expectedTerminal: "session and history can be reconstructed",
    id: "C04",
    observedEventTypes: [],
    operations: [
      await call(baseUrl, "GET", "/session", undefined, context("C04")),
      await call(
        baseUrl,
        "GET",
        sessionPath,
        undefined,
        context("C04", sessionId)
      ),
      await call(
        baseUrl,
        "GET",
        `${sessionPath}/message`,
        undefined,
        context("C04", sessionId)
      ),
      await call(baseUrl, "GET", "/session/missing", undefined, context("C04")),
    ],
    sessionId,
  });
  const emptyHistory = await call(
    baseUrl,
    "GET",
    `${sessionPath}/message`,
    undefined,
    context("C05", sessionId)
  );

  const stream = openSse(
    baseUrl,
    `${sessionPath}/event`,
    timeoutMs,
    context("C06", sessionId)
  );
  try {
    await stream.ready;
    const prompt = await call(
      baseUrl,
      "POST",
      `${sessionPath}/prompt_async`,
      {
        parts: [
          {
            text: Bun.env.CAPTURE_PROMPT ?? "contract capture text",
            type: "text",
          },
        ],
      },
      context("C06", sessionId, "C06-turn")
    );
    const sse = await stream.done;
    const observedEventTypes = sse.eventTypes;
    const completedHistory = await call(
      baseUrl,
      "GET",
      `${sessionPath}/message`,
      undefined,
      context("C06", sessionId)
    );
    results.push({
      expectedTerminal: "prompt response plus terminal SSE event",
      id: "C06",
      observedEventTypes,
      operations: [prompt, completedHistory],
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

  const populatedHistory = await call(
    baseUrl,
    "GET",
    `${sessionPath}/message`,
    undefined,
    context("C05", sessionId)
  );
  results.push({
    expectedTerminal: "empty and populated history responses received",
    id: "C05",
    observedEventTypes: [],
    operations: [emptyHistory, populatedHistory],
    sessionId,
  });
  const assistantId = bodyAssistantId(populatedHistory.body);
  const revert = await call(
    baseUrl,
    "POST",
    `${sessionPath}/revert`,
    { messageID: assistantId ?? "missing-assistant" },
    context("C13", sessionId)
  );
  results.push({
    expectedTerminal: "completed turn can be reverted",
    id: "C13",
    observedEventTypes: [],
    operations: [
      populatedHistory,
      revert,
      await call(
        baseUrl,
        "GET",
        `${sessionPath}/message`,
        undefined,
        context("C13", sessionId)
      ),
    ],
    sessionId,
  });

  const continuedStream = openSse(
    baseUrl,
    `${sessionPath}/event`,
    timeoutMs,
    context("C14", sessionId)
  );
  try {
    await continuedStream.ready;
    const continuedPrompt = await call(
      baseUrl,
      "POST",
      `${sessionPath}/prompt_async`,
      { parts: [{ text: "after rollback", type: "text" }] },
      context("C14", sessionId, "C14-turn")
    );
    const continuedEvents = await continuedStream.done;
    results.push({
      expectedTerminal: "a reverted session accepts a new turn",
      id: "C14",
      observedEventTypes: continuedEvents.eventTypes,
      operations: [
        continuedPrompt,
        await call(
          baseUrl,
          "GET",
          `${sessionPath}/message`,
          undefined,
          context("C14", sessionId)
        ),
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

  const abortStream = openSse(
    baseUrl,
    `${sessionPath}/event`,
    timeoutMs,
    context("C11", sessionId)
  );
  let abortBarrierValid = false;
  try {
    await abortStream.ready;
    const prompt = call(
      baseUrl,
      "POST",
      `${sessionPath}/prompt_async`,
      { parts: [{ text: "abort me", type: "text" }] },
      context("C11", sessionId, "C11-turn")
    );
    abortBarrierValid =
      barrier === undefined ? false : await barrier.waitFor("C11.turn-active");
    const abort = await call(
      baseUrl,
      "POST",
      `${sessionPath}/abort`,
      undefined,
      context("C11", sessionId, "C11-turn")
    );
    const promptResult = await prompt;
    const abortEvents = await abortStream.done;
    const abortHistory = await call(
      baseUrl,
      "GET",
      `${sessionPath}/message`,
      undefined,
      context("C11", sessionId)
    );
    results.push({
      expectedTerminal: "active turn abort returns and closes the stream",
      id: "C11",
      observedEventTypes: abortEvents.eventTypes,
      abortValid: abortEvents.terminalStatuses.includes("aborted"),
      barrierValid: abortBarrierValid,
      operations: [promptResult, abort, abortHistory],
      sessionId,
    });
  } catch (error) {
    abortStream.stop();
    results.push({
      expectedTerminal: "active turn abort returns and closes the stream",
      id: "C11",
      observedEventTypes: [],
      barrierValid: false,
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

  const malformed = await call(
    baseUrl,
    "POST",
    "/session",
    "not-json",
    context("C18")
  );
  const missing = await call(
    baseUrl,
    "POST",
    "/session/missing/prompt_async",
    { parts: [{ text: "missing", type: "text" }] },
    context("C18")
  );
  results.push({
    expectedTerminal: "malformed and unknown-session requests return errors",
    id: "C18",
    observedEventTypes: [],
    operations: [malformed, missing],
    sessionId,
  });

  const secondCreate = await call(
    baseUrl,
    "POST",
    "/session",
    {},
    context("C17")
  );
  const secondId = bodySessionId(secondCreate.body);
  if (secondId !== null) {
    const secondSessionPath = `/session/${encodeURIComponent(secondId)}`;
    const firstStream = openSse(
      baseUrl,
      `${sessionPath}/event`,
      timeoutMs,
      context("C17", sessionId)
    );
    const secondStream = openSse(
      baseUrl,
      `${secondSessionPath}/event`,
      timeoutMs,
      context("C17", secondId)
    );
    try {
      await Promise.all([firstStream.ready, secondStream.ready]);
      const [firstPrompt, secondPrompt] = await Promise.all([
        call(
          baseUrl,
          "POST",
          `${sessionPath}/prompt_async`,
          { parts: [{ text: "parallel one", type: "text" }] },
          context("C17", sessionId, "C17-first-turn")
        ),
        call(
          baseUrl,
          "POST",
          `/session/${encodeURIComponent(secondId)}/prompt_async`,
          { parts: [{ text: "parallel two", type: "text" }] },
          context("C17", secondId, "C17-second-turn")
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
        scopeValid:
          firstEvents.terminal &&
          firstEvents.sessionIDs.includes(sessionId) &&
          firstEvents.sessionIDs.every(
            (observed) => observed === "" || observed === sessionId
          ) &&
          secondEvents.terminal &&
          secondEvents.sessionIDs.includes(secondId) &&
          secondEvents.sessionIDs.every(
            (observed) => observed === "" || observed === secondId
          ),
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
  const scenarios = finalizeScenarios(results, barrier !== undefined);
  return {
    baseUrl,
    corpusId,
    generatedAt: new Date().toISOString(),
    runId,
    scenarios,
    status:
      scenarios.length > 0 && scenarios.every((scenario) => scenario.passed)
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
  const runId = Bun.env.CONTRACT_RUN_ID ?? Bun.env.SCENARIO_RUN_ID;
  const barrierUrl = Bun.env.SCENARIO_BARRIER_URL;
  const barrier =
    barrierUrl === undefined
      ? undefined
      : {
          waitFor: async (name: string): Promise<boolean> => {
            try {
              const url = new URL("/wait", barrierUrl);
              url.searchParams.set("name", name);
              const response = await fetch(url, { method: "POST" });
              if (!response.ok) return false;
              const body = await response.text();
              if (body.trim().length === 0) return true;
              const parsed = parsedBody(body);
              return isRecord(parsed) ? parsed.active === true : false;
            } catch {
              return false;
            }
          },
        };
  const report = await runScenarios(baseUrl, corpusId, 15_000, {
    ...(barrier === undefined ? {} : { barrier }),
    ...(runId === undefined ? {} : { runId }),
  });
  await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`scenario run ${report.status}; wrote ${output}`);
  if (report.status !== "completed") process.exitCode = 1;
}
