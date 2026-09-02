import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultWorkerHome, parseWorkerCliOptions } from "../src/cli.ts";
import {
  installFrpcConfig,
  prepareWorker,
  workerPaths,
  writeEcosystem,
} from "../src/worker.ts";

describe("CLI options", () => {
  test("starts the singleton worker with an optional FRP config", () => {
    expect(
      parseWorkerCliOptions(["start", "--frpc-config", "/tmp/frpc.toml"])
    ).toEqual({ command: "start", frpcConfig: "/tmp/frpc.toml" });
  });

  test("uses a stable machine-level state directory", () => {
    expect(defaultWorkerHome("/Users/example")).toBe(
      join("/Users/example", ".local", "share", "t3-worker")
    );
  });

  test("rejects unsupported commands and options", () => {
    expect(() => parseWorkerCliOptions(["start", "--unknown"])).toThrow(
      "Unknown argument"
    );
    expect(() =>
      parseWorkerCliOptions(["status", "--frpc-config", "x"])
    ).toThrow("--frpc-config requires the start command.");
  });

  test("generates one PM2 stack and adds frpc only with a config", () => {
    const home = mkdtempSync(join(tmpdir(), "t3-worker-"));
    try {
      const paths = workerPaths(home);
      prepareWorker(paths);
      writeEcosystem(paths, "/project", "/package", paths.frpcConfig);
      const ecosystem = readFileSync(paths.ecosystem, "utf8");
      expect(ecosystem).toContain('"name": "t3-worker-shim"');
      expect(ecosystem).toContain('"name": "t3-worker-t3"');
      expect(ecosystem).toContain('"name": "t3-worker-frpc"');
      expect(ecosystem).toContain('"PI_ALLOWED_ROOTS": "/project"');
      expect(ecosystem).toContain('"-c",');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("accepts only FRP proxies targeting local T3", () => {
    const home = mkdtempSync(join(tmpdir(), "t3-worker-"));
    try {
      const paths = workerPaths(home);
      prepareWorker(paths);
      const config = join(home, "provided.toml");
      writeFileSync(
        config,
        '[[proxies]]\nname = "t3"\ntype = "http"\nlocalPort = 3773\n'
      );
      expect(installFrpcConfig(config, paths)).toBe(paths.frpcConfig);
      writeFileSync(config, "[[proxies]]\nlocalPort = 41874\n");
      expect(() => installFrpcConfig(config, paths)).toThrow(
        "Every FRPC proxy must target 127.0.0.1:3773."
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});
