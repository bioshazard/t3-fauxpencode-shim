import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const SHIM_PORT = 41874;
export const T3_PORT = 3773;

export type WorkerPaths = {
  readonly ecosystem: string;
  readonly frpc: string;
  readonly frpcConfig: string;
  readonly home: string;
  readonly pm2Home: string;
  readonly piHome: string;
  readonly t3Home: string;
};

export function defaultWorkerHome(home = homedir()): string {
  return join(home, ".local", "share", "t3-fauxpencode");
}

export function workerPaths(home = defaultWorkerHome()): WorkerPaths {
  return {
    ecosystem: join(home, "pm2", "ecosystem.config.cjs"),
    frpc: join(home, "frp", "frpc"),
    frpcConfig: join(home, "frp", "frpc.toml"),
    home,
    pm2Home: join(home, "pm2"),
    piHome: join(home, "pi"),
    t3Home: join(home, "t3"),
  };
}

export function prepareWorker(paths: WorkerPaths): void {
  for (const path of [paths.home, paths.piHome, paths.pm2Home, paths.t3Home]) {
    mkdirSync(path, { recursive: true });
  }
  mkdirSync(dirname(paths.ecosystem), { recursive: true });
  mkdirSync(dirname(paths.frpc), { recursive: true });
}

export function installFrpcConfig(
  source: string | undefined,
  paths: WorkerPaths
): string | undefined {
  if (source === undefined) {
    return existsSync(paths.frpcConfig) ? paths.frpcConfig : undefined;
  }
  const config = resolve(source);
  if (!existsSync(config)) {
    throw new Error(`FRPC config does not exist: ${config}`);
  }
  validateFrpcConfig(readFileSync(config, "utf8"));
  copyFileSync(config, paths.frpcConfig);
  return paths.frpcConfig;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return Object.prototype.toString.call(value) === "[object Object]"
    ? (value as Record<string, unknown>)
    : null;
}

function isLoopbackT3Proxy(value: unknown): boolean {
  const proxy = asRecord(value);
  if (proxy === null || proxy.localPort !== T3_PORT) return false;
  return proxy.localIP === undefined || proxy.localIP === "127.0.0.1";
}

export function validateFrpcConfig(content: string): void {
  const config = asRecord(Bun.TOML.parse(content));
  const proxies = config?.proxies;
  if (!Array.isArray(proxies) || proxies.length === 0) {
    throw new Error("FRPC config must declare at least one T3 proxy.");
  }
  if (!proxies.every(isLoopbackT3Proxy)) {
    throw new Error(`Every FRPC proxy must target 127.0.0.1:${T3_PORT}.`);
  }
}

function frpcArchiveName(version: string): string {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const architecture = process.arch === "arm64" ? "arm64" : "amd64";
  return `frp_${version}_${platform}_${architecture}.tar.gz`;
}

export async function ensureFrpc(paths: WorkerPaths): Promise<void> {
  if (existsSync(paths.frpc)) return;
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(
      `Automatic frpc download is unsupported on ${process.platform}.`
    );
  }
  if (process.arch !== "arm64" && process.arch !== "x64") {
    throw new Error(
      `Automatic frpc download is unsupported on ${process.arch}.`
    );
  }
  const release = await fetch(
    "https://api.github.com/repos/fatedier/frp/releases/latest",
    { headers: { Accept: "application/vnd.github+json" } }
  );
  if (!release.ok)
    throw new Error(`Could not find an FRP release (${release.status}).`);
  const body = (await release.json()) as { tag_name?: unknown };
  const tag = body.tag_name;
  const version =
    Object.prototype.toString.call(tag) === "[object String]"
      ? String(tag).replace(/^v/u, "")
      : "";
  if (!/^\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9]+)*$/u.test(version)) {
    throw new Error("Latest FRP release returned an invalid version.");
  }
  const archive = frpcArchiveName(version);
  const archivePath = join(paths.home, archive);
  const extractPath = join(paths.home, `.frp-${version}-${Date.now()}`);
  try {
    console.log(`Downloading ${archive}...`);
    const download = Bun.spawn({
      cmd: [
        "curl",
        "--fail",
        "--location",
        "--retry",
        "3",
        "--silent",
        "--show-error",
        "--output",
        archivePath,
        `https://github.com/fatedier/frp/releases/download/v${version}/${archive}`,
      ],
      stderr: "inherit",
      stdout: "inherit",
    });
    if ((await download.exited) !== 0) {
      throw new Error(`Could not download ${archive}.`);
    }
    mkdirSync(extractPath, { recursive: true });
    const unpack = Bun.spawn({
      cmd: ["tar", "-xzf", archivePath, "-C", extractPath],
      stderr: "inherit",
      stdout: "inherit",
    });
    if ((await unpack.exited) !== 0) throw new Error("Could not extract frpc.");
    const binary = join(extractPath, basename(archive, ".tar.gz"), "frpc");
    if (!existsSync(binary))
      throw new Error("FRP archive did not contain frpc.");
    renameSync(binary, paths.frpc);
  } finally {
    rmSync(archivePath, { force: true });
    rmSync(extractPath, { force: true, recursive: true });
  }
}

export function writeEcosystem(
  paths: WorkerPaths,
  cwd: string,
  packageRoot: string,
  frpcConfig: string | undefined
): void {
  const apps: Array<Record<string, unknown>> = [
    {
      args: [join(packageRoot, "src", "server.ts")],
      autorestart: true,
      cwd,
      env: {
        PI_ALLOWED_ROOTS: cwd,
        PI_CWD: cwd,
        PI_OPENCODE_HOST: "127.0.0.1",
        PI_OPENCODE_PORT: String(SHIM_PORT),
        PI_SESSION_DIR: paths.piHome,
      },
      exec_interpreter: "none",
      name: "t3-fauxpencode-shim",
      script: process.execPath,
      watch: false,
    },
    {
      args: [join(packageRoot, "tools", "run-t3-shim.sh")],
      autorestart: true,
      cwd,
      env: {
        PI_OPENCODE_URL: `http://127.0.0.1:${SHIM_PORT}`,
        T3_HOME: paths.t3Home,
      },
      exec_interpreter: "none",
      name: "t3-fauxpencode-t3",
      script: "bash",
      watch: false,
    },
  ];
  if (frpcConfig !== undefined) {
    apps.push({
      args: ["-c", frpcConfig],
      autorestart: true,
      cwd,
      exec_interpreter: "none",
      name: "t3-fauxpencode-frpc",
      script: paths.frpc,
      watch: false,
    });
  }
  writeFileSync(
    paths.ecosystem,
    `module.exports = ${JSON.stringify({ apps }, null, 2)};\n`
  );
}
