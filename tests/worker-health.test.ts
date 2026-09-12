import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probeWorker } from "../src/worker-health.ts";
import { prepareWorker, workerPaths } from "../src/worker.ts";

test("JSON health reports every foreground component", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-health-"));
  try {
    const paths = workerPaths(root);
    prepareWorker(paths);
    await writeFile(paths.frpcConfig, "configured", { flush: true });
    await writeFile(
      paths.runtime,
      JSON.stringify({
        children: {
          frpc: { name: "frpc", pid: 103 },
          shim: { name: "shim", pid: 101 },
          t3: { name: "t3", pid: 102 },
        },
        instanceId: "active-instance",
        mode: "foreground",
        processStartToken: "active-process",
        startedAt: "2026-01-01T00:00:00.000Z",
        supervisorPid: 100,
      })
    );
    await mkdir(`${paths.runtime}.lock`);
    const result = await probeWorker(paths, {
      fetch: async (url) =>
        url.toString().includes("41874")
          ? Response.json({ healthy: true })
          : new Response("ok"),
      processAlive: () => true,
      processStartToken: () => "active-process",
    });

    expect(result).toEqual({
      healthy: true,
      mode: "foreground",
      schemaVersion: 1,
      services: {
        frpc: { required: true, status: "healthy" },
        shim: {
          endpoint: "http://127.0.0.1:41874/global/health",
          required: true,
          status: "healthy",
        },
        t3: {
          endpoint: "http://127.0.0.1:3773/",
          required: true,
          status: "healthy",
        },
      },
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("health rejects stale runtime ownership even when its PID was reused", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-health-"));
  try {
    const paths = workerPaths(root);
    prepareWorker(paths);
    await writeFile(
      paths.runtime,
      JSON.stringify({
        children: {
          shim: { name: "shim", pid: 101 },
          t3: { name: "t3", pid: 102 },
        },
        instanceId: "stale-instance",
        mode: "foreground",
        processStartToken: "stale-process",
        startedAt: "2026-01-01T00:00:00.000Z",
        supervisorPid: 100,
      })
    );
    await mkdir(`${paths.runtime}.lock`);

    const result = await probeWorker(paths, {
      fetch: async () => Response.json({ healthy: true }),
      processAlive: () => true,
      processStartToken: () => "reused-process",
    });

    expect(result.healthy).toBe(false);
    expect(result.mode).toBe("unknown");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("health rejects unmanaged listeners and disables absent FRPC", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-health-"));
  try {
    const result = await probeWorker(workerPaths(root), {
      fetch: async (url) => {
        if (url.toString().includes("41874")) {
          return Response.json({ healthy: true });
        }
        throw new Error("connection refused");
      },
      processAlive: () => false,
    });

    expect(result.healthy).toBe(false);
    expect(result.mode).toBe("unknown");
    expect(result.services.shim.status).toBe("unhealthy");
    expect(result.services.t3.status).toBe("unhealthy");
    expect(result.services.frpc).toEqual({
      required: false,
      status: "disabled",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("health bounds an unresponsive PM2 daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-health-"));
  try {
    const paths = workerPaths(root);
    prepareWorker(paths);
    await writeFile(join(paths.pm2Home, "pm2.pid"), String(process.pid));
    const startedAt = Date.now();

    const result = await probeWorker(paths, {
      fetch: async () => {
        throw new Error("connection refused");
      },
      pm2: {
        command: [process.execPath, "-e", "setInterval(() => undefined, 1000)"],
        timeoutMs: 50,
      },
      processAlive: () => true,
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result.healthy).toBe(false);
    expect(result.mode).toBe("unknown");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
