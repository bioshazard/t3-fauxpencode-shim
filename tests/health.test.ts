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
  version: "test",
};

const request = (path: string, method = "GET") =>
  createHandler(config)(new Request(`http://shim.test${path}`, { method }));

describe("health and discovery", () => {
  test("reports readiness", async () => {
    const response = request("/global/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      healthy: true,
      service: "pi-opencode-server",
      version: "test",
    });
  });

  test("reports the configured Pi model", async () => {
    const response = request("/provider");

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

  test("fails explicitly for unknown routes and unsupported work", async () => {
    const unknown = request("/not-in-contract");
    const session = request("/session", "POST");

    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: {
        code: "unknown_route",
        message: "No contract for GET /not-in-contract",
      },
    });
    expect(session.status).toBe(501);
    expect(await session.json()).toEqual({
      error: {
        code: "unimplemented_contract",
        message: "Session creation is the next POC slice.",
      },
    });
  });

  test("rejects wrong methods", async () => {
    const response = request("/global/health", "POST");

    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Method POST is not supported for /global/health",
      },
    });
  });
});
