import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultWorkerHome, parseWorkerCliOptions } from "../src/cli.ts";
import {
  FRPC_ARCHIVE_SHA256,
  FRPC_VERSION,
  installFrpcConfig,
  prepareWorker,
  t3WorktreesRoot,
  verifyFileSha256,
  workerPaths,
  workerProcessSpecs,
  writeEcosystem,
} from "../src/worker.ts";

describe("CLI options", () => {
  test("starts the singleton worker with an optional FRP config", () => {
    expect(
      parseWorkerCliOptions(["start", "--frpc-config", "/tmp/frpc.toml"])
    ).toEqual({ command: "start", frpcConfig: "/tmp/frpc.toml" });
  });

  test("accepts container lifecycle commands through the published CLI", () => {
    expect(
      parseWorkerCliOptions(["run", "--frpc-config", "/etc/frp/frpc.toml"])
    ).toEqual({ command: "run", frpcConfig: "/etc/frp/frpc.toml" });
    expect(parseWorkerCliOptions(["connection"])).toEqual({
      command: "connection",
    });
    expect(parseWorkerCliOptions(["health", "--json"])).toEqual({
      command: "health",
      json: true,
    });
  });

  test("uses a stable machine-level state directory", () => {
    expect(defaultWorkerHome("/Users/example")).toBe(
      join("/Users/example", ".local", "share", "t3-fauxpencode")
    );
  });

  test("rejects unsupported commands and options", () => {
    expect(() => parseWorkerCliOptions(["start", "--unknown"])).toThrow(
      "Unknown argument"
    );
    expect(() =>
      parseWorkerCliOptions(["status", "--frpc-config", "x"])
    ).toThrow("--frpc-config requires the start or run command.");
    expect(() => parseWorkerCliOptions(["run", "--json"])).toThrow(
      "--json requires the health command."
    );
  });

  test("uses one process graph for detached and foreground modes", () => {
    const home = mkdtempSync(join(tmpdir(), "t3-fauxpencode-"));
    try {
      const paths = workerPaths(home);
      const specs = workerProcessSpecs(
        paths,
        "/workspace",
        "/package",
        paths.frpcConfig,
        "/workspaces"
      );

      expect(specs.map((spec) => spec.id)).toEqual(["shim", "t3", "frpc"]);
      expect(specs[0]?.command).toEqual([
        process.execPath,
        "/package/src/server.ts",
      ]);
      expect(specs[0]?.env.PI_ALLOWED_ROOTS).toContain("/workspaces");
      expect(specs[1]?.env.T3_HOME).toBe(paths.t3Home);
      expect(specs[2]?.command).toEqual([paths.frpc, "-c", paths.frpcConfig]);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("pins FRPC archives and rejects a checksum mismatch", () => {
    const home = mkdtempSync(join(tmpdir(), "t3-fauxpencode-"));
    try {
      const archive = join(home, "frpc.tar.gz");
      writeFileSync(archive, "fixture archive");
      expect(FRPC_VERSION).toBe("0.71.0");
      expect(Object.keys(FRPC_ARCHIVE_SHA256).sort()).toEqual([
        "darwin-amd64",
        "darwin-arm64",
        "linux-amd64",
        "linux-arm64",
      ]);
      expect(() => verifyFileSha256(archive, "0".repeat(64))).toThrow(
        "FRPC archive checksum mismatch"
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("generates one PM2 stack and adds frpc only with a config", () => {
    const home = mkdtempSync(join(tmpdir(), "t3-fauxpencode-"));
    try {
      const paths = workerPaths(home);
      prepareWorker(paths);
      expect(paths.ecosystem).toEndWith("ecosystem.config.cjs");
      writeEcosystem(paths, "/project", "/package", paths.frpcConfig);
      const ecosystem = readFileSync(paths.ecosystem, "utf8");
      expect(ecosystem).toContain('"name": "t3-fauxpencode-shim"');
      expect(ecosystem).toContain('"name": "t3-fauxpencode-t3"');
      expect(ecosystem).toContain('"name": "t3-fauxpencode-frpc"');
      expect(ecosystem).toContain(
        `"PI_ALLOWED_ROOTS": "/project,${join(paths.t3Home, "worktrees")}"`
      );
      expect(existsSync(t3WorktreesRoot(paths))).toBe(true);
      expect(ecosystem).toContain('"-c",');

      writeEcosystem(
        paths,
        "/project",
        "/package",
        undefined,
        "/workspaces/dev"
      );
      expect(readFileSync(paths.ecosystem, "utf8")).toContain(
        `"PI_ALLOWED_ROOTS": "/workspaces/dev,${join(paths.t3Home, "worktrees")}"`
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("accepts only FRP proxies targeting local T3", () => {
    const home = mkdtempSync(join(tmpdir(), "t3-fauxpencode-"));
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

  test("uses the installed FRP config for the local PM2 stack", () => {
    const ecosystem = readFileSync("ecosystem.config.cjs", "utf8");
    expect(ecosystem).toContain('".local", "share", "t3-fauxpencode", "frp"');
    expect(ecosystem).toContain('join(frpcHome, "frpc.toml")');
  });

  test("keeps macOS awake while T3 runs", () => {
    const launcher = readFileSync("tools/run-t3-shim.sh", "utf8");
    expect(launcher).toContain("keep_awake=(caffeinate -i)");
    expect(launcher).toContain('exec "${keep_awake[@]}" bunx');
    expect(launcher).toContain("t3@${T3_VERSION:-0.0.39}");
  });
});
