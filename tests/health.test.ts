import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config.ts";
import { createHandler, SSE_IDLE_TIMEOUT_SECONDS } from "../src/server.ts";
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

const request = async (path: string, method = "GET") =>
  createHandler(config)(new Request(`http://shim.test${path}`, { method }));

describe("health and discovery", () => {
  test("loads a T3-compatible OpenCode health version", () => {
    expect(loadConfig({}).version).toBe("1.14.19");
  });

  test("loads allowed roots from JSON configuration", () => {
    expect(
      loadConfig({
        PI_ALLOWED_ROOTS: JSON.stringify({ roots: ["/tmp/projects"] }),
        PI_CWD: "/tmp",
      }).allowedRoots
    ).toEqual(["/tmp/projects"]);
  });

  test("rejects malformed allowed roots configuration", () => {
    expect(() => loadConfig({ PI_ALLOWED_ROOTS: "not-json" })).toThrow(
      "PI_ALLOWED_ROOTS must be valid JSON."
    );
  });

  test("keeps Bun SSE connections alive indefinitely", () => {
    expect(SSE_IDLE_TIMEOUT_SECONDS).toBe(0);
  });

  test("reports readiness", async () => {
    const response = await request("/global/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      healthy: true,
      service: "pi-opencode-server",
      version: "test",
    });
  });

  test("reports the configured Pi model", async () => {
    const response = await request("/provider");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      all: [
        {
          env: [],
          id: "pi",
          models: expect.any(Object),
          name: "Pi",
          options: {},
          source: "custom",
        },
      ],
      connected: ["pi"],
      default: { pi: "test-model" },
    });
    expect(
      (body as { all: [{ models: Record<string, unknown> }] }).all[0].models[
        "test-model"
      ]
    ).toMatchObject({ id: "test-model", name: "test-model", providerID: "pi" });
  });

  test("exposes empty optional discovery lists", async () => {
    const agents = await request("/agent");
    const skills = await request("/skill");

    expect(agents.status).toBe(200);
    expect(skills.status).toBe(200);
    expect(await agents.json()).toEqual([]);
    expect(await skills.json()).toEqual([]);
  });

  test("exposes empty pending interaction lists", async () => {
    const permissions = await request("/permission");
    const questions = await request("/question");

    expect(permissions.status).toBe(200);
    expect(questions.status).toBe(200);
    expect(await permissions.json()).toEqual([]);
    expect(await questions.json()).toEqual([]);
  });

  test("fails explicitly for unknown routes and malformed work", async () => {
    const unknown = await request("/not-in-contract");
    const session = await createHandler(config)(
      new Request("http://shim.test/session", {
        body: "not-json",
        method: "POST",
      })
    );

    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: {
        code: "unknown_route",
        message: "No contract for GET /not-in-contract",
      },
    });
    expect(session.status).toBe(400);
    expect(await session.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "Request body must be valid JSON.",
      },
    });
  });

  test("accepts T3 directory query params on discovery routes", async () => {
    const health = await request("/global/health?directory=/tmp/projects/x");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      healthy: true,
      service: "pi-opencode-server",
      version: "test",
    });

    const permissions = await request("/permission?directory=/tmp/projects/x");
    expect(permissions.status).toBe(200);
    expect(await permissions.json()).toEqual([]);

    const events = await request("/event?directory=/tmp/projects/x");
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
  });

  test("rejects wrong methods", async () => {
    const response = await request("/global/health", "POST");

    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Method POST is not supported for /global/health",
      },
    });
  });
});
