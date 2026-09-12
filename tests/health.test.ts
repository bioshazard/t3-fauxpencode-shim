import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { createHandler, SSE_IDLE_TIMEOUT_SECONDS } from "../src/server.ts";
import type { ShimConfig } from "../src/types.ts";

let root: string;
let config: ShimConfig;
let handler: ReturnType<typeof createHandler>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-health-discovery-"));
  const agentDir = join(root, "agent");
  const extensions = join(agentDir, "extensions");
  await mkdir(extensions, { recursive: true });
  await writeFile(
    join(extensions, "fixture-provider.ts"),
    `export default (pi) => {
      pi.registerProvider("fixture-provider", {
        api: "openai-completions",
        apiKey: "fixture-key",
        baseUrl: "http://fixture.invalid/v1",
        async refreshModels() {
          return [{
            id: "fixture-model",
            name: "Fixture Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4096,
            maxTokens: 1024
          }];
        }
      });
    };`
  );
  config = {
    agentDir,
    allowedRoots: [root],
    cwd: root,
    host: "127.0.0.1",
    modelId: "test-model",
    port: 4096,
    providerId: "pi",
    sessionDir: undefined,
    version: "test",
  };
  handler = createHandler(config);
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

const request = async (path: string, method = "GET") =>
  handler(new Request(`http://shim.test${path}`, { method }));

describe("health and discovery", () => {
  test("loads a T3-compatible OpenCode health version", () => {
    expect(loadConfig({}).version).toBe("1.14.19");
  });

  test("loads allowed roots from comma-separated configuration", () => {
    expect(
      loadConfig({
        PI_ALLOWED_ROOTS: "/tmp/projects, /tmp/other-project",
        PI_CWD: "/tmp",
      }).allowedRoots
    ).toEqual(["/tmp/projects", "/tmp/other-project"]);
  });

  test("rejects empty allowed root entries", () => {
    expect(() =>
      loadConfig({ PI_ALLOWED_ROOTS: "/tmp/projects,,/tmp/other" })
    ).toThrow(
      "PI_ALLOWED_ROOTS must be a comma-separated list of directory paths."
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

  test("always reports the configured Pi model alongside pi registry models", async () => {
    const response = await request("/provider");

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      all: Array<{
        env: unknown;
        id: string;
        models: Record<string, unknown>;
        name: string;
        options: unknown;
        source: string;
      }>;
      connected: string[];
      default: Record<string, string>;
    };
    expect(body.default).toEqual({ pi: "test-model" });
    expect(body.connected).toContain("pi");
    const configured = body.all.find((provider) => provider.id === "pi");
    expect(configured).toBeDefined();
    expect(configured).toMatchObject({
      env: [],
      name: "Pi",
      options: {},
      source: "custom",
    });
    expect(configured!.models["test-model"]).toMatchObject({
      id: "test-model",
      name: "test-model",
      providerID: "pi",
    });
    expect(body.connected).toContain("fixture-provider");
    const dynamic = body.all.find(
      (provider) => provider.id === "fixture-provider"
    );
    expect(dynamic?.models["fixture-model"]).toMatchObject({
      id: "fixture-model",
      name: "Fixture Model",
      providerID: "fixture-provider",
    });
    // Every discovered model belongs to its provider and stays selectable.
    for (const provider of body.all) {
      expect(provider.env).toEqual([]);
      expect(provider.source).toBe("custom");
      for (const [id, model] of Object.entries(provider.models)) {
        expect(model).toMatchObject({ id, providerID: provider.id });
      }
    }
  });

  test("falls back to the configured model when pi registry discovery is empty", async () => {
    const { providerResponse } = await import("../src/opencode.ts");

    const body = providerResponse(config);
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
  });

  test("exposes agents and Pi-loaded skills", async () => {
    const agents = await request("/agent");
    const skills = await request("/skill");

    expect(agents.status).toBe(200);
    expect(skills.status).toBe(200);
    expect(await agents.json()).toEqual([]);
    expect(await skills.json()).toEqual(expect.any(Array));
  });

  test("exposes only skill discovery metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-skill-discovery-"));
    const skillDirectory = join(root, "skills", "contract-skill");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      `---\nname: contract-skill\ndescription: Visible discovery text.\n---\n\nSecret instructions.\n`
    );

    try {
      const fixtureHandler = createHandler({
        ...config,
        agentDir: root,
        cwd: root,
      });
      const [response] = await Promise.all([
        fixtureHandler(new Request("http://shim.test/skill")),
        fixtureHandler(new Request("http://shim.test/provider")),
      ]);
      const skills = (await response.json()) as Array<Record<string, unknown>>;
      const skill = skills.find((item) => item.name === "contract-skill");

      expect(response.status).toBe(200);
      expect(skill).toEqual({
        description: "Visible discovery text.",
        location: "pi-skill:contract-skill",
        name: "contract-skill",
      });
      expect(skills.every((item) => !("content" in item))).toBe(true);
      for (const item of skills) {
        expect(item.location).toBe(`pi-skill:${String(item.name)}`);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
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
    const session = await handler(
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
