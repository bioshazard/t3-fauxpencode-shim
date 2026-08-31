import { describe, expect, test } from "bun:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
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
    expect(translated[0]?.properties.messageId).toBe("msg_external");
    expect(translated[0]?.properties.message?.id).toBe("msg_external");
  });
});
