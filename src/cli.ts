#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  defaultWorkerHome,
  ensureFrpc,
  installFrpcConfig,
  prepareWorker,
  workerPaths,
  writeEcosystem,
} from "./worker.ts";

export { defaultWorkerHome } from "./worker.ts";

export type WorkerCommand = "logs" | "restart" | "start" | "status" | "stop";
export type WorkerCliOptions = {
  readonly command: WorkerCommand;
  readonly frpcConfig?: string;
};

function usage(): string {
  return [
    "Usage: t3-fauxpencode <command> [options]",
    "",
    "Commands: start, stop, restart, status, logs",
    "",
    "  --frpc-config <path>      Install this TOML config and run frpc (start only).",
  ].join("\n");
}

export function parseWorkerCliOptions(
  args: readonly string[]
): WorkerCliOptions {
  const command = args[0] as WorkerCommand | undefined;
  if (
    !command ||
    !["start", "stop", "restart", "status", "logs"].includes(command)
  ) {
    throw new Error(`Unknown command: ${args[0] ?? ""}\n\n${usage()}`);
  }
  let frpcConfig: string | undefined;
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
    throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
  }
  if (frpcConfig !== undefined && command !== "start") {
    throw new Error("--frpc-config requires the start command.");
  }
  return { command, frpcConfig };
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

export async function runCli(args = Bun.argv.slice(2)): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  const options = parseWorkerCliOptions(args);
  const paths = workerPaths(Bun.env.T3_WORKER_HOME ?? defaultWorkerHome());
  const packageRoot = resolve(import.meta.dir, "..");
  if (options.command === "status") {
    await runPm2(["status"], paths.pm2Home);
    return;
  }
  if (options.command === "logs") {
    await runPm2(["logs", "--lines", "100"], paths.pm2Home);
    return;
  }
  if (options.command === "stop") {
    if (!existsSync(paths.ecosystem)) return;
    await runPm2(["delete", paths.ecosystem], paths.pm2Home);
    return;
  }
  prepareWorker(paths);
  const frpcConfig = installFrpcConfig(options.frpcConfig, paths);
  if (frpcConfig !== undefined) await ensureFrpc(paths);
  writeEcosystem(paths, process.cwd(), packageRoot, frpcConfig);
  await runPm2(
    [options.command === "restart" ? "restart" : "start", paths.ecosystem],
    paths.pm2Home
  );
}

if (import.meta.main) void runCli();
