import { describe, expect, test } from "bun:test";

import { createHandler } from "../src/server.ts";
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

const request = async (path: string, method = "GET") =>
  createHandler(config)(new Request(`http://shim.test${path}`, { method }));

describe("health and discovery", () => {
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
    expect(await response.json()).toEqual({
      default: "pi",
      providers: [
        {
          id: "pi",
          models: [{ id: "test-model", name: "test-model" }],
          name: "Pi",
        },
      ],
    });
  });

  test("exposes empty optional discovery lists", async () => {
    const agents = await request("/agent");
    const skills = await request("/skill");

    expect(agents.status).toBe(200);
    expect(skills.status).toBe(200);
    expect(await agents.json()).toEqual([]);
    expect(await skills.json()).toEqual([]);
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
