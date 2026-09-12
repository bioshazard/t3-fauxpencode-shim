import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { discoverPiModels } from "../src/server.ts";
import type { ShimConfig } from "../src/types.ts";

let root: string;
let config: ShimConfig;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-model-discovery-"));
  config = {
    agentDir: root,
    allowedRoots: [root],
    cwd: root,
    host: "127.0.0.1",
    modelId: "configured",
    port: 4096,
    providerId: "pi",
    sessionDir: undefined,
    version: "test",
  };
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

test("cancels discovery when SDK service bootstrap ignores the deadline", async () => {
  const controller = new AbortController();
  const originalRefresh = ModelRuntime.prototype.refresh;
  const runtimes = new WeakSet<ModelRuntime>();
  let bootstrapStalled = false;
  const refreshSpy = spyOn(
    ModelRuntime.prototype,
    "refresh"
  ).mockImplementation(function (this: ModelRuntime, options) {
    if (options?.signal === controller.signal) {
      runtimes.add(this);
      return originalRefresh.call(this, options);
    }
    if (!runtimes.has(this)) return originalRefresh.call(this, options);
    bootstrapStalled = true;
    controller.abort(new Error("bootstrap deadline exceeded"));
    return new Promise(() => undefined);
  });
  const logSpy = spyOn(console, "error").mockImplementation(() => undefined);

  try {
    expect(await discoverPiModels(config, controller.signal)).toEqual([]);
    expect(bootstrapStalled).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(
      "pi model discovery failed: bootstrap deadline exceeded"
    );
  } finally {
    refreshSpy.mockRestore();
    logSpy.mockRestore();
  }
});

test("passes the same deadline to the final refresh and bounds an ignored abort", async () => {
  const controller = new AbortController();
  const originalRefresh = ModelRegistry.prototype.refresh;
  let refreshSignal: AbortSignal | undefined;
  const refreshSpy = spyOn(
    ModelRegistry.prototype,
    "refresh"
  ).mockImplementation(function (this: ModelRegistry, options) {
    if (options?.signal !== controller.signal) {
      return originalRefresh.call(this, options);
    }
    refreshSignal = options?.signal;
    controller.abort(new Error("refresh deadline exceeded"));
    return new Promise(() => undefined);
  });
  const logSpy = spyOn(console, "error").mockImplementation(() => undefined);

  try {
    expect(await discoverPiModels(config, controller.signal)).toEqual([]);
    expect(refreshSignal).toBe(controller.signal);
    expect(logSpy).toHaveBeenCalledWith(
      "pi model discovery failed: refresh deadline exceeded"
    );
  } finally {
    refreshSpy.mockRestore();
    logSpy.mockRestore();
  }
});
