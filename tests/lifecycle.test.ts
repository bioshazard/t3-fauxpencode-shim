import { describe, expect, test } from "bun:test";

import { EventHub } from "../src/events.ts";
import { createHandler } from "../src/server.ts";
import { InMemorySessionBackend, SessionRegistry } from "../src/sessions.ts";
import type { FacadeEvent, ShimConfig } from "../src/types.ts";

const config: ShimConfig = {
  agentDir: undefined,
  allowedRoots: [process.cwd()],
  cwd: process.cwd(),
  host: "127.0.0.1",
  modelId: "test-model",
  port: 4096,
  providerId: "pi",
  sessionDir: undefined,
  version: "test",
};

function createTestHandler() {
  const events = new EventHub();
  const registry = new SessionRegistry(new InMemorySessionBackend());
  return { events, handler: createHandler(config, registry, events), registry };
}

async function createSession(
  handler: ReturnType<typeof createHandler>,
  id: string
): Promise<void> {
  const response = await handler(
    new Request("http://shim.test/session", {
      body: JSON.stringify({ cwd: process.cwd(), id }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  expect(response.status).toBe(200);
}

function promptRequest(id: string, text: string): Request {
  return new Request(`http://shim.test/session/${id}/message`, {
    body: JSON.stringify({ parts: [{ text, type: "text" }] }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

describe("prompt and lifecycle facade", () => {
  test("preserves a caller message ID in snapshots and message events", async () => {
    const { events, handler, registry } = createTestHandler();
    await createSession(handler, "thread-message-id");
    const seen: FacadeEvent[] = [];

    const snapshot = await registry.promptSession(
      "thread-message-id",
      { images: [], messageId: "msg_external", text: "hello" },
      (event) => {
        events.publish(event);
        seen.push(event);
      }
    );

    expect(snapshot?.messages[0]?.id).toBe("msg_external");
    expect(
      seen.some(
        (event) =>
          event.type === "message.created" &&
          event.properties.messageId === "msg_external"
      )
    ).toBe(true);

    const lookup = await handler(
      new Request(
        "http://shim.test/session/thread-message-id/message/msg_external"
      )
    );
    expect(lookup.status).toBe(200);
    expect((await lookup.json()).info.id).toBe("msg_external");
  });

  test("streams scoped SSE events and retains a tool result", async () => {
    const { handler } = createTestHandler();
    await createSession(handler, "thread-tools");

    const stream = await handler(new Request("http://shim.test/global/event"));
    const reader = stream.body?.getReader();
    expect(reader).not.toBeUndefined();
    const decoder = new TextDecoder();
    const connected = await reader?.read();
    expect(decoder.decode(connected?.value)).toContain(": connected");

    const prompt = handler(promptRequest("thread-tools", "tool: list_files"));
    let frames = "";
    for (
      let index = 0;
      index < 20 && !frames.includes("tool.completed");
      index += 1
    ) {
      const chunk = await reader?.read();
      if (chunk?.done === true) break;
      frames += decoder.decode(chunk?.value);
    }
    const completed = await prompt;
    await reader?.cancel();

    expect(completed.status).toBe(200);
    expect(frames).toContain('"sessionID":"thread-tools"');
    expect(frames).toContain("tool.started");
    expect(frames).toContain("tool.completed");
    expect((await completed.json()).info.role).toBe("assistant");
    const history = await handler(
      new Request("http://shim.test/session/thread-tools/message")
    );
    const historyBody = await history.json();
    expect(historyBody).toHaveLength(2);
    expect(historyBody[1].parts).toContainEqual(
      expect.objectContaining({
        callID: "thread-tools-tool-1",
        state: expect.objectContaining({ status: "completed" }),
        tool: "list_files",
        type: "tool",
      })
    );
    const assistantId = historyBody[1].info.id;
    const lookup = await handler(
      new Request(
        `http://shim.test/session/thread-tools/message/${assistantId}`
      )
    );
    expect(lookup.status).toBe(200);
    expect((await lookup.json()).info.id).toBe(assistantId);
  });

  test("accepts asynchronous prompts and reports session status", async () => {
    const { handler } = createTestHandler();
    await createSession(handler, "thread-async");
    const status = await handler(
      new Request("http://shim.test/session/status")
    );
    expect(await status.json()).toEqual({ "thread-async": { type: "idle" } });

    const prompt = await handler(
      new Request("http://shim.test/session/thread-async/prompt_async", {
        body: JSON.stringify({ text: "async" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    expect(prompt.status).toBe(204);
  });

  test("aborts an active turn without adding an assistant message", async () => {
    const { handler, registry } = createTestHandler();
    await createSession(handler, "thread-abort");

    const session = await registry.getSession("thread-abort");
    if (session === null) throw new Error("test session was not created");
    const events: FacadeEvent[] = [];
    const prompt = session.prompt("long response", (event) =>
      events.push(event)
    );
    await Promise.resolve();
    const abort = handler(
      new Request("http://shim.test/session/thread-abort/abort", {
        method: "POST",
      })
    );
    const repeatedAbort = handler(
      new Request("http://shim.test/session/thread-abort/abort", {
        method: "POST",
      })
    );
    const [promptSnapshot, abortResponse, repeatedAbortResponse] =
      await Promise.all([prompt, abort, repeatedAbort]);

    expect(abortResponse.status).toBe(200);
    expect(await abortResponse.json()).toBe(true);
    expect(repeatedAbortResponse.status).toBe(200);
    expect(await repeatedAbortResponse.json()).toBe(true);
    expect(promptSnapshot.messages).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          error: expect.objectContaining({ name: "MessageAbortedError" }),
        }),
        type: "session.error",
      })
    );
    expect(
      events.filter((event) => event.type === "session.error")
    ).toHaveLength(1);
    const abortEventIndex = events.findIndex(
      (event) => event.type === "session.error"
    );
    expect(events[abortEventIndex + 1]).toMatchObject({
      properties: { status: { type: "idle" } },
      type: "session.status",
    });
  });

  test("reverts a completed turn and continues from the resulting state", async () => {
    const { handler } = createTestHandler();
    await createSession(handler, "thread-revert");
    await handler(promptRequest("thread-revert", "first"));

    const before = await handler(
      new Request("http://shim.test/session/thread-revert/message")
    );
    const beforeBody = await before.json();
    const target = beforeBody[1].info.id;
    const reverted = await handler(
      new Request("http://shim.test/session/thread-revert/revert", {
        body: JSON.stringify({ messageID: target }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );

    expect(reverted.status).toBe(200);
    expect(reverted.status).toBe(200);
    const afterRevert = await handler(
      new Request("http://shim.test/session/thread-revert/message")
    );
    expect(await afterRevert.json()).toHaveLength(1);
    await handler(promptRequest("thread-revert", "second"));
    const continued = await handler(
      new Request("http://shim.test/session/thread-revert/message")
    );
    const messages = await continued.json();
    expect(messages).toHaveLength(3);
    expect(messages[2].parts[0].text).toBe("Echo: second");
  });

  test("keeps concurrent session events isolated", async () => {
    const { events, registry } = createTestHandler();
    const handler = createHandler(config, registry, events);
    await createSession(handler, "thread-a");
    await createSession(handler, "thread-b");
    const seen: string[] = [];
    const unsubscribe = events.subscribe((event) => seen.push(event.sessionID));

    await Promise.all([
      registry.promptSession("thread-a", "alpha", (event) =>
        events.publish(event)
      ),
      registry.promptSession("thread-b", "beta", (event) =>
        events.publish(event)
      ),
    ]);
    unsubscribe();

    expect(new Set(seen)).toEqual(new Set(["thread-a", "thread-b"]));
    expect(
      seen.every(
        (sessionId) => sessionId === "thread-a" || sessionId === "thread-b"
      )
    ).toBe(true);
  });
});
