import { describe, expect, test } from "bun:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { translateAgentEvent, translateMessages } from "../src/translation.ts";

describe("Pi message ID translation", () => {
  test("uses caller IDs for user snapshots and completion events", () => {
    const user: UserMessage = {
      content: "hello",
      role: "user",
      timestamp: Date.now(),
    };
    const messages: AgentMessage[] = [user];
    const overrides = new Map<AgentMessage, string>([[user, "msg_external"]]);

    expect(translateMessages("thread", messages, overrides)[0]?.id).toBe(
      "msg_external"
    );

    const event = {
      message: user,
      type: "message_end",
    } as AgentSessionEvent;
    const translated = translateAgentEvent(
      "thread",
      event,
      messages,
      new Map(),
      overrides
    );
    expect(translated[0]?.type).toBe("message.updated");
    expect(translated[0]?.properties.sessionID).toBe("thread");
    expect(translated[0]?.properties.info?.id).toBe("msg_external");
    expect(translated[0]?.properties.info?.role).toBe("user");
  });

  test("uses configured provider and model identity in native events", () => {
    const assistant: AssistantMessage = {
      content: [{ text: "hello", type: "text" }],
      role: "assistant",
      timestamp: 2,
    } as unknown as AssistantMessage;
    const translated = translateAgentEvent(
      "thread",
      { message: assistant, type: "message_end" } as AgentSessionEvent,
      [assistant],
      new Map(),
      new Map(),
      { agent: "pi", modelId: "configured", providerId: "custom-pi" }
    );

    expect(translated[0]?.properties.info).toMatchObject({
      modelID: "configured",
      providerID: "custom-pi",
    });
  });

  test("emits native OpenCode streaming events with cumulative text parts", () => {
    const user: UserMessage = {
      content: "hello",
      role: "user",
      timestamp: 1,
    };
    const assistant: AssistantMessage = {
      content: [],
      role: "assistant",
      timestamp: 2,
    } as unknown as AssistantMessage;
    const messages: AgentMessage[] = [user, assistant];
    const overrides = new Map<AgentMessage, string>([[user, "msg_external"]]);
    const eventIds = new Map<string, string>();
    const translated = (event: AgentSessionEvent) =>
      translateAgentEvent("thread", event, messages, eventIds, overrides);

    const busy = translated({ type: "agent_start" });
    const userStart = translated({ type: "message_start", message: user });
    const assistantStart = translated({
      type: "message_start",
      message: assistant,
    });
    const firstDelta = translated({
      assistantMessageEvent: {
        contentIndex: 0,
        delta: "Hello",
        partial: assistant,
        type: "text_delta",
      },
      message: assistant,
      type: "message_update",
    });
    const secondDelta = translated({
      assistantMessageEvent: {
        contentIndex: 0,
        delta: " world",
        partial: assistant,
        type: "text_delta",
      },
      message: assistant,
      type: "message_update",
    });
    const assistantEnd = translated({
      type: "message_end",
      message: assistant,
    });
    const idle = translated({ type: "agent_settled" });

    expect(busy[0]?.properties.status).toEqual({ type: "busy" });
    expect(userStart[0]?.properties.info?.id).toBe("msg_external");
    expect(assistantStart[0]?.properties.info?.role).toBe("assistant");
    expect(firstDelta[0]?.type).toBe("message.part.updated");
    expect(firstDelta[0]?.properties.part).toMatchObject({
      messageID: "thread-message-2",
      sessionID: "thread",
      text: "Hello",
      type: "text",
    });
    expect(secondDelta[0]?.properties.part).toMatchObject({
      id: firstDelta[0]?.properties.part?.id,
      text: "Hello world",
    });
    expect(assistantEnd[0]?.type).toBe("message.updated");
    expect(assistantEnd[0]?.properties.info?.id).toBe("thread-message-2");
    expect(idle[0]?.properties.status).toEqual({ type: "idle" });
  });

  test("emits final tool parts without exposing partial tool JSON as text", () => {
    const assistant: AssistantMessage = {
      content: [
        {
          arguments: { command: "ls" },
          id: "call_ls",
          name: "bash",
          type: "toolCall",
        },
      ],
      role: "assistant",
      timestamp: 2,
    } as unknown as AssistantMessage;
    const translated = (event: AgentSessionEvent) =>
      translateAgentEvent("thread", event, [assistant]);

    expect(
      translated({
        assistantMessageEvent: {
          contentIndex: 0,
          delta: '{"command":"ls"}',
          partial: assistant,
          type: "toolcall_delta",
        },
        message: assistant,
        type: "message_update",
      })
    ).toEqual([]);

    const completed = translated({ type: "message_end", message: assistant });
    expect(completed).toHaveLength(2);
    expect(completed[1]?.properties.part).toMatchObject({
      callID: "call_ls",
      state: { input: { command: "ls" }, status: "pending" },
      tool: "bash",
      type: "tool",
    });
  });
});
