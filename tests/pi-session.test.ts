import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

import {
  PiBackendSession,
  PiSessionBackend,
  SessionRegistry,
} from "../src/sessions.ts";
import type { FacadeEvent } from "../src/types.ts";
import type { ShimConfig } from "../src/types.ts";

describe("Pi session backend", () => {
  test("relays a detached completion after its originating prompt settles", async () => {
    const messages: AgentMessage[] = [];
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const session = {
      dispose: () => undefined,
      get isStreaming() {
        return false;
      },
      messages,
      model: undefined,
      prompt: async () => undefined,
      sessionManager: {
        getEntries: () => [],
        getHeader: () => null,
      },
      subscribe: (next: (event: AgentSessionEvent) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };
    const backend = new PiBackendSession(
      "parent",
      session as unknown as AgentSession,
      process.cwd(),
      "parent",
      [],
      { agent: "pi", modelId: "configured", providerId: "pi" }
    );
    const seen: FacadeEvent[] = [];

    await backend.prompt("start a detached worker", (event) =>
      seen.push(event)
    );

    const completed: AssistantMessage = {
      api: "pi-messages",
      content: [{ text: "worker finished", type: "text" }],
      model: "test-model",
      provider: "test",
      role: "assistant",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 0,
        output: 0,
        totalTokens: 0,
      },
    };
    messages.push(completed);
    listener?.({
      message: completed,
      type: "message_end",
    } as AgentSessionEvent);

    expect(backend.snapshot().messages).toContainEqual(
      expect.objectContaining({
        parts: [{ text: "worker finished", type: "text" }],
      })
    );
    expect(
      seen.filter(
        (event) =>
          event.type === "message.part.updated" &&
          (event.properties.part as { readonly text?: string }).text ===
            "worker finished"
      )
    ).toHaveLength(1);
  });

  test("reopens a persisted Pi JSONL session", async () => {
    const sessionDir = `/tmp/pi-opencode-shim-test-${crypto.randomUUID()}`;
    const config: ShimConfig = {
      agentDir: undefined,
      allowedRoots: [process.cwd()],
      cwd: process.cwd(),
      host: "127.0.0.1",
      modelId: "configured",
      port: 4096,
      providerId: "pi",
      sessionDir,
      version: "test",
    };

    try {
      const manager = SessionManager.create(config.cwd, sessionDir, {
        id: "pi-session",
      });
      const user: UserMessage = {
        content: "hello",
        role: "user",
        timestamp: Date.now(),
      };
      const assistant: AssistantMessage = {
        api: "pi-messages",
        content: [{ text: "hello back", type: "text" }],
        model: "test-model",
        provider: "test",
        role: "assistant",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          cacheRead: 0,
          cacheWrite: 0,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
          input: 0,
          output: 0,
          totalTokens: 0,
        },
      };
      const userEntryId = manager.appendMessage(user);
      manager.appendMessage(assistant);
      manager.appendCustomEntry("pi-opencode-shim-message-id", {
        facadeId: "caller-user-id",
        messageEntryId: userEntryId,
      });

      const reopened = await new SessionRegistry(
        new PiSessionBackend(config)
      ).getSnapshot("pi-session");

      expect(reopened?.id).toBe("pi-session");
      expect(reopened?.messages).toHaveLength(2);
      expect(reopened?.messages[0]?.id).toBe("caller-user-id");
      expect(reopened?.messages[1]?.parts[0]).toEqual({
        text: "hello back",
        type: "text",
      });
    } finally {
      await Bun.spawn(["rm", "-rf", sessionDir]).exited;
    }
  });

  test("hides persisted sessions outside the configured roots", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-shim-sessions-"));
    const allowedRoot = await mkdtemp(join(tmpdir(), "pi-shim-allowed-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "pi-shim-outside-"));
    const config: ShimConfig = {
      agentDir: undefined,
      allowedRoots: [allowedRoot],
      cwd: allowedRoot,
      host: "127.0.0.1",
      modelId: "configured",
      port: 4096,
      providerId: "pi",
      sessionDir,
      version: "test",
    };

    try {
      const allowed = SessionManager.create(allowedRoot, sessionDir, {
        id: "allowed",
      });
      const outside = SessionManager.create(outsideRoot, sessionDir, {
        id: "outside",
      });
      allowed.appendCustomEntry("pi-opencode-shim", { facadeId: "allowed" });
      outside.appendCustomEntry("pi-opencode-shim", { facadeId: "outside" });
      const assistant: AssistantMessage = {
        api: "pi-messages",
        content: [{ text: "persisted", type: "text" }],
        model: "test-model",
        provider: "test",
        role: "assistant",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          cacheRead: 0,
          cacheWrite: 0,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
          input: 0,
          output: 0,
          totalTokens: 0,
        },
      };
      allowed.appendMessage(assistant);
      outside.appendMessage(assistant);
      const backend = new PiSessionBackend(config);

      expect(
        (await backend.listSessions()).map((session) => session.id)
      ).toEqual(["allowed"]);
      expect(await backend.openSession("outside")).toBeNull();
    } finally {
      await Promise.all([
        rm(sessionDir, { force: true, recursive: true }),
        rm(allowedRoot, { force: true, recursive: true }),
        rm(outsideRoot, { force: true, recursive: true }),
      ]);
    }
  });
});
