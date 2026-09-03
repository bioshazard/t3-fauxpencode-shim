import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHandler } from "../src/server.ts";
import { InMemorySessionBackend, SessionRegistry } from "../src/sessions.ts";
import type { ShimConfig } from "../src/types.ts";

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
    const created = await first(
      post(JSON.stringify({ cwd: process.cwd(), id: "thread-1" }))
    );

    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({
      id: "thread-1",
      directory: realpathSync(process.cwd()),
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

    const created = await handler(
      post(JSON.stringify({ cwd: process.cwd(), id: "same" }))
    );
    const duplicate = await handler(
      post(JSON.stringify({ cwd: process.cwd(), id: "same" }))
    );
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

describe("session creation directory selection", () => {
  let root: string;
  let projectA: string;
  let projectB: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-shim-fallback-"));
    projectA = await mkdtemp(join(root, "project-a-"));
    projectB = await mkdtemp(join(root, "project-b-"));
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  const directoryHandler = () =>
    createHandler(
      { ...config, cwd: root, allowedRoots: [root] },
      new SessionRegistry(new InMemorySessionBackend())
    );

  test("falls back to the configured launch directory", async () => {
    const handler = directoryHandler();
    const response = await handler(post(JSON.stringify({ id: "quiet" })));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      directory: realpathSync(root),
      id: "quiet",
    });

    const empty = await handler(
      new Request("http://shim.test/session", { method: "POST" })
    );
    expect(empty.status).toBe(200);
  });

  test("creates the session in the directory signaled by the /event stream", async () => {
    const handler = directoryHandler();
    const events = await handler(
      new Request(`http://shim.test/event?directory=${projectA}`)
    );
    expect(events.status).toBe(200);

    const response = await handler(post(JSON.stringify({ id: "from-event" })));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      directory: realpathSync(projectA),
      id: "from-event",
    });
  });

  test("lets an explicit cwd win over the tracked directory", async () => {
    const handler = directoryHandler();
    await handler(new Request(`http://shim.test/event?directory=${projectA}`));

    const response = await handler(
      post(JSON.stringify({ cwd: projectB, id: "explicit" }))
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      directory: realpathSync(projectB),
      id: "explicit",
    });
  });

  test("ignores an event directory outside the allowed roots", async () => {
    const handler = directoryHandler();
    await handler(new Request(`http://shim.test/event?directory=${tmpdir()}`));

    const response = await handler(post(JSON.stringify({ id: "outside" })));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      directory: realpathSync(root),
      id: "outside",
    });
  });

  test("does not let background discovery override an event directory", async () => {
    const handler = directoryHandler();
    await handler(new Request(`http://shim.test/event?directory=${projectA}`));
    await handler(
      new Request(`http://shim.test/global/health?directory=${projectB}`)
    );

    const response = await handler(post(JSON.stringify({ id: "event-wins" })));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      directory: realpathSync(projectA),
      id: "event-wins",
    });
  });
});
