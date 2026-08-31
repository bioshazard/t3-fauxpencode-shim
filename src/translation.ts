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
  SessionStatus,
} from "./types.ts";

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
  message: AgentMessage
): FacadeMessage | null {
  const id = `${sessionId}-message-${index + 1}`;
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
  messages: readonly AgentMessage[]
): readonly FacadeMessage[] {
  return messages.flatMap((message, index) => {
    const translated = translateMessage(sessionId, index, message);
    return translated === null ? [] : [translated];
  });
}

function sessionEvent(
  sessionID: string,
  type: string,
  properties: FacadeEvent["properties"] = {}
): FacadeEvent {
  return { id: crypto.randomUUID(), properties, sessionID, type };
}

function latestMessage(
  sessionID: string,
  messages: readonly AgentMessage[]
): FacadeMessage | undefined {
  const translated = translateMessages(sessionID, messages);
  return translated[translated.length - 1];
}

function statusEvent(sessionID: string, status: SessionStatus): FacadeEvent {
  return sessionEvent(sessionID, "session.status", {
    sessionStatus: status,
  });
}

function eventMessageId(
  sessionID: string,
  message: AgentMessage,
  messages: readonly AgentMessage[],
  messageIds: Map<string, string>
): string | undefined {
  if (
    message.role !== "user" &&
    message.role !== "assistant" &&
    message.role !== "toolResult"
  ) {
    return undefined;
  }
  const key = `${message.role}:${message.timestamp}`;
  const known = messageIds.get(key);
  if (known !== undefined) return known;
  const index = messages.indexOf(message);
  const id = `${sessionID}-message-${index < 0 ? messages.length + 1 : index + 1}`;
  messageIds.set(key, id);
  return id;
}

export function translateAgentEvent(
  sessionID: string,
  event: AgentSessionEvent,
  messages: readonly AgentMessage[],
  messageIds: Map<string, string> = new Map()
): readonly FacadeEvent[] {
  switch (event.type) {
    case "agent_start":
      return [statusEvent(sessionID, "running")];
    case "agent_settled":
      return [statusEvent(sessionID, "idle")];
    case "agent_end":
      return [statusEvent(sessionID, event.willRetry ? "running" : "idle")];
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (
        update.type !== "text_delta" &&
        update.type !== "thinking_delta" &&
        update.type !== "toolcall_delta"
      ) {
        return [];
      }
      return [
        sessionEvent(sessionID, "message.part.updated", {
          delta: update.delta,
          messageId: eventMessageId(
            sessionID,
            event.message,
            messages,
            messageIds
          ),
        }),
      ];
    }
    case "message_end": {
      const message = latestMessage(sessionID, messages);
      const messageId = eventMessageId(
        sessionID,
        event.message,
        messages,
        messageIds
      );
      return message === undefined
        ? []
        : [
            sessionEvent(sessionID, "message.completed", {
              message:
                messageId === undefined
                  ? message
                  : { ...message, id: messageId },
              messageId: messageId ?? message.id,
            }),
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
      const message = latestMessage(sessionID, messages);
      const messageId = eventMessageId(
        sessionID,
        event.message,
        messages,
        messageIds
      );
      return [
        sessionEvent(sessionID, "turn.completed", {
          message:
            messageId === undefined || message === undefined
              ? message
              : { ...message, id: messageId },
          messageId: messageId ?? message?.id,
        }),
      ];
    }
    default:
      return [];
  }
}
