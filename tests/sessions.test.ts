import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  test("rejects session cwd outside configured allowed roots", async () => {
    const handler = createHandler(
      { ...config, allowedRoots: [process.cwd()] },
      new SessionRegistry(new InMemorySessionBackend())
    );

    const response = await handler(
      post(JSON.stringify({ cwd: "/tmp", id: "outside-root" }))
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "cwd_not_allowed",
        message: "The requested session cwd is outside the configured roots.",
      },
    });
  });

  test("rejects a symlinked cwd that escapes an allowed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-shim-root-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-shim-outside-"));
    const linked = join(root, "linked");
    await symlink(outside, linked, "dir");

    try {
      const handler = createHandler(
        { ...config, allowedRoots: [root] },
        new SessionRegistry(new InMemorySessionBackend())
      );
      const response = await handler(
        post(JSON.stringify({ cwd: linked, id: "symlink-escape" }))
      );

      expect(response.status).toBe(403);
    } finally {
      await Promise.all([
        rm(root, { force: true, recursive: true }),
        rm(outside, { force: true, recursive: true }),
      ]);
    }
  });

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

    const updated = await first(
      new Request("http://shim.test/session/thread-1", {
        body: JSON.stringify({
          permission: [{ action: "allow", pattern: "**", permission: "read" }],
        }),
        method: "PATCH",
      })
    );
    expect(updated.status).toBe(200);
    expect((await updated.json()).permission).toEqual([
      { action: "allow", pattern: "**", permission: "read" },
    ]);

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
