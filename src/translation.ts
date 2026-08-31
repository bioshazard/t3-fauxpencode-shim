import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";

import type { FacadeMessage, FacadePart, JsonValue } from "./types.ts";

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
