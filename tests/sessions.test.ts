import { describe, expect, test } from "bun:test";

import { createHandler } from "../src/server.ts";
import { InMemorySessionBackend, SessionRegistry } from "../src/sessions.ts";
import type { ShimConfig } from "../src/types.ts";

const config: ShimConfig = {
  agentDir: undefined,
  cwd: "/tmp/poc",
  host: "127.0.0.1",
  modelId: "test-model",
  port: 4096,
  providerId: "pi",
  sessionDir: undefined,
  version: "test",
};

function post(body: string) {
  return new Request("http://shim.test/session", {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

describe("session registry facade", () => {
  test("creates, lists, reads, and lazily reopens a session", async () => {
    const backend = new InMemorySessionBackend();
    const first = createHandler(config, new SessionRegistry(backend));
    const created = await first(post(JSON.stringify({ id: "thread-1" })));

    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({
      id: "thread-1",
      directory: "/tmp/poc",
      title: "Pi session thread-1",
    });

    const listed = await first(new Request("http://shim.test/session"));
    expect(await listed.json()).toHaveLength(1);

    const reopened = createHandler(config, new SessionRegistry(backend));
    const session = await reopened(
      new Request("http://shim.test/session/thread-1")
    );
    const history = await reopened(
      new Request("http://shim.test/session/thread-1/message")
    );

    expect(session.status).toBe(200);
    expect((await session.json()).id).toBe("thread-1");
    expect(await history.json()).toEqual([]);
  });

  test("rejects invalid create payloads and duplicate ids", async () => {
    const backend = new InMemorySessionBackend();
    const handler = createHandler(config, new SessionRegistry(backend));

    const invalid = await handler(post(JSON.stringify({ cwd: 42 })));
    expect(invalid.status).toBe(400);

    const created = await handler(post(JSON.stringify({ id: "same" })));
    const duplicate = await handler(post(JSON.stringify({ id: "same" })));
    expect(created.status).toBe(200);
    expect(duplicate.status).toBe(409);
  });

  test("returns a stable missing-session error", async () => {
    const response = await createHandler(config)(
      new Request("http://shim.test/session/missing/message")
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "unknown_session",
        message: "The requested session does not exist.",
      },
    });
  });
});
