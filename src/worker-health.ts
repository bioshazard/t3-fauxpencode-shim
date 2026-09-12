import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readRuntimeState } from "./supervisor.ts";
import {
  SHIM_PORT,
  T3_PORT,
  type WorkerPaths,
  type WorkerProcessId,
} from "./worker.ts";

type ServiceStatus = "disabled" | "healthy" | "unhealthy";
type ServiceHealth = {
  readonly endpoint?: string;
  readonly required: boolean;
  readonly status: ServiceStatus;
};
export type WorkerHealth = {
  readonly healthy: boolean;
  readonly mode: "detached" | "foreground" | "unknown";
  readonly schemaVersion: 1;
  readonly services: Record<WorkerProcessId, ServiceHealth>;
};

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

type ProbeOptions = {
  readonly fetch?: Fetcher;
  readonly processAlive?: (pid: number) => boolean;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Object.prototype.toString.call(value) === "[object Object]"
    ? (value as Record<string, unknown>)
    : undefined;
}

function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function probeHttp(
  fetcher: Fetcher,
  endpoint: string,
  expectShimBody = false
): Promise<boolean> {
  try {
    const response = await fetcher(endpoint, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    if (!expectShimBody) return true;
    const body = (await response.json()) as { readonly healthy?: unknown };
    return body.healthy === true;
  } catch {
    return false;
  }
}

async function detachedStates(
  paths: WorkerPaths,
  alive: (pid: number) => boolean
): Promise<ReadonlyMap<string, string>> {
  const pm2Pid = join(paths.pm2Home, "pm2.pid");
  if (!existsSync(pm2Pid)) return new Map();
  const pid = Number(readFileSync(pm2Pid, "utf8").trim());
  if (!Number.isInteger(pid) || !alive(pid)) return new Map();
  const child = Bun.spawn({
    cmd: ["bunx", "pm2@7.0.4", "jlist"],
    env: { ...Bun.env, PM2_HOME: paths.pm2Home },
    stderr: "ignore",
    stdout: "pipe",
  });
  const [code, output] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  if (code !== 0) return new Map();
  try {
    const processes = JSON.parse(output) as unknown;
    if (!Array.isArray(processes)) return new Map();
    return new Map(
      processes.map(asRecord).flatMap((item) => {
        const name = item?.name;
        const status = asRecord(item?.pm2_env)?.status;
        return isString(name) && isString(status) ? [[name, status]] : [];
      })
    );
  } catch {
    return new Map();
  }
}

export async function probeWorker(
  paths: WorkerPaths,
  options: ProbeOptions = {}
): Promise<WorkerHealth> {
  const fetcher = options.fetch ?? fetch;
  const alive = options.processAlive ?? processAlive;
  const runtime = readRuntimeState(paths.runtime);
  const foreground = runtime !== undefined && alive(runtime.supervisorPid);
  const detached = foreground ? new Map() : await detachedStates(paths, alive);
  const mode = foreground
    ? "foreground"
    : detached.size > 0
      ? "detached"
      : "unknown";
  const shimEndpoint = `http://127.0.0.1:${SHIM_PORT}/global/health`;
  const t3Endpoint = `http://127.0.0.1:${T3_PORT}/`;
  const [shimHealthy, t3Healthy] = await Promise.all([
    probeHttp(fetcher, shimEndpoint, true),
    probeHttp(fetcher, t3Endpoint),
  ]);
  const componentHealthy = (
    id: WorkerProcessId,
    detachedName: string,
    endpointHealthy: boolean
  ) => {
    const foregroundPid = runtime?.children[id]?.pid;
    const managed = foreground
      ? foregroundPid !== undefined && alive(foregroundPid)
      : detached.get(detachedName) === "online";
    return managed && endpointHealthy;
  };
  const managedShimHealthy = componentHealthy(
    "shim",
    "t3-fauxpencode-shim",
    shimHealthy
  );
  const managedT3Healthy = componentHealthy(
    "t3",
    "t3-fauxpencode-t3",
    t3Healthy
  );
  const frpcRequired = existsSync(paths.frpcConfig);
  const foregroundFrpc = runtime?.children.frpc?.pid;
  const frpcHealthy = foreground
    ? foregroundFrpc !== undefined && alive(foregroundFrpc)
    : detached.get("t3-fauxpencode-frpc") === "online";
  const services: WorkerHealth["services"] = {
    frpc: {
      required: frpcRequired,
      status: frpcRequired
        ? frpcHealthy
          ? "healthy"
          : "unhealthy"
        : "disabled",
    },
    shim: {
      endpoint: shimEndpoint,
      required: true,
      status: managedShimHealthy ? "healthy" : "unhealthy",
    },
    t3: {
      endpoint: t3Endpoint,
      required: true,
      status: managedT3Healthy ? "healthy" : "unhealthy",
    },
  };
  return {
    healthy: Object.values(services).every(
      (service) => !service.required || service.status === "healthy"
    ),
    mode,
    schemaVersion: 1,
    services,
  };
}

export function formatWorkerHealth(health: WorkerHealth): string {
  return [
    `worker: ${health.healthy ? "healthy" : "unhealthy"} (${health.mode})`,
    ...(["shim", "t3", "frpc"] as const).map(
      (id) => `${id}: ${health.services[id].status}`
    ),
  ].join("\n");
}
