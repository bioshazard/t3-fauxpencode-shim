import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type {
  FacadeEvent,
  FacadeMessage,
  FacadePart,
  JsonValue,
  OpenCodeMessageInfo,
  OpenCodePart,
  OpenCodeTextPart,
  SessionStatus,
} from "./types.ts";

export interface TranslationIdentity {
  readonly agent: string;
  readonly modelId: string;
  readonly providerId: string;
}

const DEFAULT_IDENTITY: TranslationIdentity = {
  agent: "pi",
  modelId: "pi",
  providerId: "pi",
};

function textPart(text: string): FacadePart {
  return { text, type: "text" };
}

function translateUserContent(
  content: UserMessage["content"]
): readonly FacadePart[] {
  if (!Array.isArray(content)) return [textPart(content)];
  return content.flatMap((part): readonly FacadePart[] => {
    if (part.type === "text") return [textPart(part.text)];
    if (part.type === "image") {
      return [{ data: part.data, mimeType: part.mimeType, type: "image" }];
    }
    return [];
  });
}

function translateAssistantContent(
  content: AssistantMessage["content"]
): readonly FacadePart[] {
  return content.flatMap((part): readonly FacadePart[] => {
    if (part.type === "text") return [textPart(part.text)];
    if (part.type === "thinking")
      return [{ text: part.thinking, type: "reasoning" }];
    if (part.type === "toolCall") {
      return [
        {
          id: part.id,
          input: part.arguments as JsonValue,
          name: part.name,
          type: "tool-call",
        },
      ];
    }
    return [];
  });
}

function translateToolResultContent(
  content: ToolResultMessage["content"]
): string {
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

function translateMessage(
  sessionId: string,
  index: number,
  message: AgentMessage,
  messageIds: ReadonlyMap<AgentMessage, string>
): FacadeMessage | null {
  const id = messageIds.get(message) ?? `${sessionId}-message-${index + 1}`;
  if (message.role === "user") {
    return {
      id,
      parts: translateUserContent(message.content),
      role: "user",
      time: { created: message.timestamp },
    };
  }
  if (message.role === "assistant") {
    return {
      id,
      parts: translateAssistantContent(message.content),
      role: "assistant",
      time: { completed: message.timestamp, created: message.timestamp },
    };
  }
  if (message.role !== "toolResult") return null;
  return {
    id,
    parts: [
      {
        error: message.isError,
        name: message.toolName,
        text: translateToolResultContent(message.content),
        toolCallId: message.toolCallId,
        type: "tool-result",
      },
    ],
    role: "tool",
    time: { completed: message.timestamp, created: message.timestamp },
  };
}

export function translateMessages(
  sessionId: string,
  messages: readonly AgentMessage[],
  messageIds: ReadonlyMap<AgentMessage, string> = new Map()
): readonly FacadeMessage[] {
  return messages.flatMap((message, index) => {
    const translated = translateMessage(sessionId, index, message, messageIds);
    return translated === null ? [] : [translated];
  });
}

function sessionEvent(
  sessionID: string,
  type: string,
  properties: FacadeEvent["properties"] = {}
): FacadeEvent {
  return {
    id: crypto.randomUUID(),
    properties: { ...properties, sessionID },
    sessionID,
    type,
  };
}

function statusEvent(sessionID: string, status: SessionStatus): FacadeEvent {
  return sessionEvent(sessionID, "session.status", {
    status: { type: status === "running" ? "busy" : "idle" },
  });
}

function messageInfo(
  sessionID: string,
  message: FacadeMessage,
  identity: TranslationIdentity
): OpenCodeMessageInfo {
  if (message.role === "user") {
    return {
      agent: identity.agent,
      id: message.id,
      model: { modelID: identity.modelId, providerID: identity.providerId },
      role: "user",
      sessionID,
      time: message.time,
    };
  }
  return {
    agent: identity.agent,
    cost: 0,
    ...(message.time.completed === undefined ? {} : { finish: "stop" }),
    id: message.id,
    mode: "all",
    modelID: identity.modelId,
    parentID: "",
    path: { cwd: "", root: "" },
    providerID: identity.providerId,
    role: "assistant",
    sessionID,
    time: message.time,
    tokens: {
      cache: { read: 0, write: 0 },
      input: 0,
      output: 0,
      reasoning: 0,
    },
  };
}

function messageUpdatedEvent(
  sessionID: string,
  message: FacadeMessage,
  identity: TranslationIdentity
): FacadeEvent {
  return sessionEvent(sessionID, "message.updated", {
    info: messageInfo(sessionID, message, identity),
  });
}

function messagePartUpdatedEvent(
  sessionID: string,
  messageID: string,
  contentIndex: number,
  type: "text" | "reasoning",
  text: string,
  timestamp: number
): FacadeEvent {
  const part: OpenCodeTextPart = {
    id: `${messageID}-part-${contentIndex + 1}`,
    messageID,
    sessionID,
    text,
    time: { start: timestamp },
    type,
  };
  return sessionEvent(sessionID, "message.part.updated", {
    part,
    time: timestamp,
  });
}

function toolPartUpdatedEvent(
  sessionID: string,
  message: FacadeMessage,
  part: Extract<FacadePart, { readonly type: "tool-call" | "tool-result" }>,
  contentIndex: number
): FacadeEvent {
  const base = {
    id: `${message.id}-part-${contentIndex + 1}`,
    messageID: message.id,
    sessionID,
  };
  const toolPart: OpenCodePart =
    part.type === "tool-call"
      ? {
          ...base,
          callID: part.id,
          state: {
            input: part.input,
            raw: JSON.stringify(part.input),
            status: "pending",
          },
          tool: part.name,
          type: "tool",
        }
      : {
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
          tool: part.name,
          type: "tool",
        };
  return sessionEvent(sessionID, "message.part.updated", {
    part: toolPart,
    time: message.time.completed ?? message.time.created,
  });
}

function completedMessagePartEvents(
  sessionID: string,
  message: FacadeMessage
): readonly FacadeEvent[] {
  if (message.role === "user") return [];
  return message.parts.flatMap((part, contentIndex) => {
    if (part.type === "tool-call" || part.type === "tool-result") {
      return [toolPartUpdatedEvent(sessionID, message, part, contentIndex)];
    }
    if (part.type === "text" || part.type === "reasoning") {
      return [
        messagePartUpdatedEvent(
          sessionID,
          message.id,
          contentIndex,
          part.type,
          part.text,
          message.time.created
        ),
      ];
    }
    return [];
  });
}

function eventMessageId(
  sessionID: string,
  message: AgentMessage,
  messages: readonly AgentMessage[],
  eventMessageIds: Map<string, string>,
  messageIdOverrides: ReadonlyMap<AgentMessage, string>
): string | undefined {
  if (
    message.role !== "user" &&
    message.role !== "assistant" &&
    message.role !== "toolResult"
  ) {
    return undefined;
  }
  const key = `${message.role}:${message.timestamp}`;
  const known = eventMessageIds.get(key);
  if (known !== undefined) return known;
  const override = messageIdOverrides.get(message);
  if (override !== undefined) {
    eventMessageIds.set(key, override);
    return override;
  }
  const index = messages.indexOf(message);
  const id = `${sessionID}-message-${index < 0 ? messages.length + 1 : index + 1}`;
  eventMessageIds.set(key, id);
  return id;
}

export function translateAgentEvent(
  sessionID: string,
  event: AgentSessionEvent,
  messages: readonly AgentMessage[],
  messageIds: Map<string, string> = new Map(),
  messageIdOverrides: ReadonlyMap<AgentMessage, string> = new Map(),
  identity: TranslationIdentity = DEFAULT_IDENTITY
): readonly FacadeEvent[] {
  switch (event.type) {
    case "agent_start":
      return [statusEvent(sessionID, "running")];
    case "agent_settled":
      return [statusEvent(sessionID, "idle")];
    case "agent_end":
      return [statusEvent(sessionID, event.willRetry ? "running" : "idle")];
    case "message_start": {
      const message = translateMessage(
        sessionID,
        messages.indexOf(event.message),
        event.message,
        messageIdOverrides
      );
      return message === null
        ? []
        : [messageUpdatedEvent(sessionID, message, identity)];
    }
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (update.type !== "text_delta" && update.type !== "thinking_delta") {
        return [];
      }
      const messageID = eventMessageId(
        sessionID,
        event.message,
        messages,
        messageIds,
        messageIdOverrides
      );
      if (messageID === undefined || !("contentIndex" in update)) return [];
      const contentIndex = update.contentIndex;
      const partKey = `part:${messageID}:${contentIndex}:${update.type}`;
      const text = (messageIds.get(partKey) ?? "") + update.delta;
      messageIds.set(partKey, text);
      return [
        messagePartUpdatedEvent(
          sessionID,
          messageID,
          contentIndex,
          update.type === "thinking_delta" ? "reasoning" : "text",
          text,
          event.message.timestamp
        ),
      ];
    }
    case "message_end": {
      const messageId = eventMessageId(
        sessionID,
        event.message,
        messages,
        messageIds,
        messageIdOverrides
      );
      const message = translateMessage(
        sessionID,
        messages.indexOf(event.message),
        event.message,
        messageIdOverrides
      );
      if (message === null) return [];
      return [
        messageUpdatedEvent(
          sessionID,
          messageId === undefined ? message : { ...message, id: messageId },
          identity
        ),
        ...completedMessagePartEvents(
          sessionID,
          messageId === undefined ? message : { ...message, id: messageId }
        ),
      ];
    }
    case "tool_execution_start":
      return [
        sessionEvent(sessionID, "tool.started", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        }),
      ];
    case "tool_execution_end":
      return [
        sessionEvent(sessionID, "tool.completed", {
          isError: event.isError,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        }),
      ];
    case "turn_end": {
      return [];
    }
    default:
      return [];
  }
}
