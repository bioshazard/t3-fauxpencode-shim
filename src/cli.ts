#!/usr/bin/env bun

import { join, resolve } from "node:path";

import { loadConfig } from "./config.ts";
import { runServer } from "./server.ts";

export type CliOptions = {
  readonly t3Home?: string;
  readonly withT3: boolean;
};

function usage(): string {
  return [
    "Usage: pi-opencode-shim [--with-t3] [--t3-home <directory>]",
    "",
    "  --with-t3                 Start an isolated T3 worker with shim settings.",
    "  --t3-home <directory>     T3 settings directory (default: <PI_CWD>/.pi-opencode-shim/t3-home).",
  ].join("\n");
}

export function parseCliOptions(args: readonly string[]): CliOptions {
  let t3Home: string | undefined;
  let withT3 = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--with-t3") {
      withT3 = true;
      continue;
    }
    if (argument === "--t3-home") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--t3-home requires a directory.");
      }
      t3Home = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
  }
  if (t3Home !== undefined && !withT3) {
    throw new Error("--t3-home requires --with-t3.");
  }
  return { t3Home, withT3 };
}

export function defaultT3Home(cwd: string): string {
  return join(cwd, ".pi-opencode-shim", "t3-home");
}

export async function runCli(args = Bun.argv.slice(2)): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  const options = parseCliOptions(args);
  const config = loadConfig();
  const server = runServer(config);
  if (!options.withT3) return;

  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    server.stop(true);
  };
  const packageRoot = resolve(import.meta.dir, "..");
  const t3Home = resolve(options.t3Home ?? defaultT3Home(config.cwd));
  try {
    const worker = Bun.spawn({
      cmd: ["bash", resolve(packageRoot, "tools", "run-t3-shim.sh")],
      cwd: config.cwd,
      env: {
        ...Bun.env,
        PI_OPENCODE_URL:
          Bun.env.PI_OPENCODE_URL ?? `http://127.0.0.1:${config.port}`,
        T3_HOME: t3Home,
      },
      signal: controller.signal,
      stderr: "inherit",
      stdout: "inherit",
    });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.exitCode = await worker.exited;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    stop();
  }
}

if (import.meta.main) void runCli();
