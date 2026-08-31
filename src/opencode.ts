import type {
  FacadeMessage,
  FacadePart,
  JsonValue,
  Provider,
  ProviderModel,
  ProviderResponse,
  SessionSnapshot,
  ShimConfig,
} from "./types.ts";

export interface OpenCodeSessionMessage {
  readonly [key: string]: JsonValue;
  readonly info: JsonValue;
  readonly parts: readonly JsonValue[];
}

function model(config: ShimConfig): ProviderModel {
  return {
    api: { id: "pi", npm: "@earendil-works/pi-ai", url: "" },
    capabilities: {
      attachment: true,
      input: {
        audio: false,
        image: true,
        pdf: false,
        text: true,
        video: false,
      },
      interleaved: false,
      output: {
        audio: false,
        image: false,
        pdf: false,
        text: true,
        video: false,
      },
      reasoning: true,
      temperature: true,
      toolcall: true,
    },
    cost: { cache: { read: 0, write: 0 }, input: 0, output: 0 },
    headers: {},
    id: config.modelId,
    limit: { context: 128_000, output: 16_000 },
    name: config.modelId,
    options: {},
    providerID: config.providerId,
    release_date: new Date(0).toISOString(),
    status: "active",
  };
}

export function providerResponse(config: ShimConfig): ProviderResponse {
  const provider: Provider = {
    env: [],
    id: config.providerId,
    models: { [config.modelId]: model(config) },
    name: "Pi",
    options: {},
    source: "custom",
  };
  return {
    all: [provider],
    connected: [provider.id],
    default: { [provider.id]: config.modelId },
  };
}

export function sessionResponse(
  snapshot: SessionSnapshot,
  config: ShimConfig
): JsonValue {
  return {
    agent: "pi",
    cost: 0,
    directory: snapshot.cwd,
    id: snapshot.id,
    model: { id: config.modelId, providerID: config.providerId },
    permission: snapshot.permission,
    projectID: snapshot.cwd,
    slug: snapshot.id,
    time: snapshot.time,
    title: snapshot.title,
    tokens: {
      cache: { read: 0, write: 0 },
      input: 0,
      output: 0,
      reasoning: 0,
    },
    version: config.version,
  };
}

function partId(messageId: string, index: number): string {
  return `${messageId}-part-${index + 1}`;
}

function toOpenCodePart(
  sessionId: string,
  message: FacadeMessage,
  part: FacadePart,
  index: number
): JsonValue | null {
  const id = partId(message.id, index);
  const base = { id, messageID: message.id, sessionID: sessionId };
  if (part.type === "text") return { ...base, text: part.text, type: "text" };
  if (part.type === "reasoning")
    return {
      ...base,
      text: part.text,
      time: { start: message.time.created },
      type: "reasoning",
    };
  if (part.type === "image") {
    return {
      ...base,
      mime: part.mimeType,
      type: "file",
      url: `data:${part.mimeType};base64,${part.data}`,
    };
  }
  if (part.type === "tool-call") {
    return {
      ...base,
      callID: part.id,
      state: {
        input: part.input,
        raw: JSON.stringify(part.input),
        status: "pending",
      },
      tool: part.name,
      type: "tool",
    };
  }
  return {
    ...base,
    callID: part.toolCallId,
    state: {
      input: {},
      metadata: {},
      output: part.text,
      status: part.error ? "error" : "completed",
      ...(part.error ? { error: part.text } : { title: "completed" }),
      time: {
        end: message.time.completed ?? message.time.created,
        start: message.time.created,
      },
    },
    tool: part.toolCallId,
    type: "tool",
  };
}

function messageInfo(
  sessionId: string,
  message: FacadeMessage,
  config: ShimConfig
): JsonValue {
  if (message.role === "user") {
    return {
      agent: "pi",
      id: message.id,
      model: { modelID: config.modelId, providerID: config.providerId },
      role: "user",
      sessionID: sessionId,
      time: { created: message.time.created },
    };
  }
  return {
    agent: "pi",
    cost: 0,
    finish: "stop",
    id: message.id,
    mode: "all",
    modelID: config.modelId,
    parentID: "",
    path: { cwd: "", root: "" },
    providerID: config.providerId,
    role: "assistant",
    sessionID: sessionId,
    time: message.time,
    tokens: {
      cache: { read: 0, write: 0 },
      input: 0,
      output: 0,
      reasoning: 0,
    },
  };
}

export function messagesResponse(
  snapshot: SessionSnapshot,
  config: ShimConfig
): readonly OpenCodeSessionMessage[] {
  const entries: Array<{ info: JsonValue; parts: JsonValue[] }> = [];
  let assistant: { info: JsonValue; parts: JsonValue[] } | undefined;
  for (const message of snapshot.messages) {
    if (message.role === "tool") {
      const part = message.parts[0];
      const translated =
        part === undefined
          ? null
          : toOpenCodePart(snapshot.id, message, part, 0);
      if (translated !== null && assistant !== undefined)
        assistant.parts.push(translated);
      continue;
    }
    const entry = {
      info: messageInfo(snapshot.id, message, config),
      parts: [] as JsonValue[],
    };
    message.parts.forEach((part, index) => {
      const translated = toOpenCodePart(snapshot.id, message, part, index);
      if (translated !== null) entry.parts.push(translated);
    });
    entries.push(entry);
    assistant = message.role === "assistant" ? entry : undefined;
  }
  return entries;
}
