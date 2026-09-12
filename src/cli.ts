#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { printConnection } from "./connection.ts";
import { runForeground } from "./supervisor.ts";
import { formatWorkerHealth, probeWorker } from "./worker-health.ts";
import {
  defaultWorkerHome,
  ensureFrpc,
  installFrpcConfig,
  prepareWorker,
  workerProcessSpecs,
  workerPaths,
  writeEcosystem,
} from "./worker.ts";

export { defaultWorkerHome } from "./worker.ts";

export type WorkerCommand =
  | "connection"
  | "health"
  | "logs"
  | "restart"
  | "run"
  | "start"
  | "status"
  | "stop";
export type WorkerCliOptions = {
  readonly command: WorkerCommand;
  readonly frpcConfig?: string;
  readonly json?: boolean;
};

function usage(): string {
  return [
    "Usage: t3-fauxpencode <command> [options]",
    "",
    "Commands: run, connection, health, start, stop, restart, status, logs",
    "",
    "  --frpc-config <path>      Install this TOML config and run frpc (start/run).",
    "  --json                    Emit machine-readable health output (health only).",
  ].join("\n");
}

export function parseWorkerCliOptions(
  args: readonly string[]
): WorkerCliOptions {
  const command = args[0] as WorkerCommand | undefined;
  if (
    !command ||
    ![
      "connection",
      "health",
      "logs",
      "restart",
      "run",
      "start",
      "status",
      "stop",
    ].includes(command)
  ) {
    throw new Error(`Unknown command: ${args[0] ?? ""}\n\n${usage()}`);
  }
  let frpcConfig: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--frpc-config") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--frpc-config requires a path.");
      }
      frpcConfig = value;
      index += 1;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
  }
  if (frpcConfig !== undefined && command !== "start" && command !== "run") {
    throw new Error("--frpc-config requires the start or run command.");
  }
  if (json && command !== "health") {
    throw new Error("--json requires the health command.");
  }
  return {
    command,
    ...(frpcConfig === undefined ? {} : { frpcConfig }),
    ...(json ? { json: true } : {}),
  };
}

async function runPm2(args: readonly string[], pm2Home: string): Promise<void> {
  const child = Bun.spawn({
    cmd: ["bunx", "pm2@7.0.4", ...args],
    env: { ...Bun.env, PM2_HOME: pm2Home },
    stderr: "inherit",
    stdout: "inherit",
  });
  if ((await child.exited) !== 0) throw new Error("PM2 command failed.");
}

export async function runCli(args = Bun.argv.slice(2)): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const options = parseWorkerCliOptions(args);
  const paths = workerPaths(Bun.env.T3_WORKER_HOME ?? defaultWorkerHome());
  const packageRoot = resolve(import.meta.dir, "..");
  if (options.command === "connection") {
    await printConnection(paths);
    return 0;
  }
  if (options.command === "health") {
    const health = await probeWorker(paths);
    console.log(
      options.json ? JSON.stringify(health) : formatWorkerHealth(health)
    );
    return health.healthy ? 0 : 1;
  }
  if (options.command === "status") {
    await runPm2(["status"], paths.pm2Home);
    return 0;
  }
  if (options.command === "logs") {
    await runPm2(["logs", "--lines", "100"], paths.pm2Home);
    return 0;
  }
  if (options.command === "stop") {
    if (!existsSync(paths.ecosystem)) return 0;
    await runPm2(["delete", paths.ecosystem], paths.pm2Home);
    return 0;
  }
  prepareWorker(paths);
  const frpcConfig = installFrpcConfig(options.frpcConfig, paths);
  if (frpcConfig !== undefined) await ensureFrpc(paths);
  if (options.command === "run") {
    return runForeground(
      workerProcessSpecs(
        paths,
        process.cwd(),
        packageRoot,
        frpcConfig,
        Bun.env.PI_ALLOWED_ROOTS
      ),
      paths.runtime
    );
  }
  writeEcosystem(
    paths,
    process.cwd(),
    packageRoot,
    frpcConfig,
    Bun.env.PI_ALLOWED_ROOTS
  );
  await runPm2(
    [options.command === "restart" ? "restart" : "start", paths.ecosystem],
    paths.pm2Home
  );
  return 0;
}

if (import.meta.main) process.exitCode = await runCli();
