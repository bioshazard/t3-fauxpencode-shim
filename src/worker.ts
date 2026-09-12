import { createHash } from "node:crypto";
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
export const FRPC_VERSION = "0.71.0";
export const FRPC_ARCHIVE_SHA256 = {
  "darwin-amd64":
    "1b1b4e2f1836e21e8733f1dddaacd4ed9ae67d7dbee39046b9d7b7eda6253637",
  "darwin-arm64":
    "45be02b186860d375ed49a8941ae9569628a54bf14e67fc36b29c98c99dabcc6",
  "linux-amd64":
    "84f27e39f11169f7adcef8e8b70c9329de17747b1f14dad9fb95eef5682ea716",
  "linux-arm64":
    "f33c293c275d8fc68c654b6fba8f10b2551d6463d09a9fc9cffb7227eae82266",
} as const;

export type WorkerProcessId = "frpc" | "shim" | "t3";
export type WorkerProcessSpec = {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly id: WorkerProcessId;
  readonly name: string;
};

export type WorkerPaths = {
  readonly ecosystem: string;
  readonly frpc: string;
  readonly frpcConfig: string;
  readonly frpcVersion: string;
  readonly home: string;
  readonly pm2Home: string;
  readonly piHome: string;
  readonly runtime: string;
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
    frpcVersion: join(home, "frp", "version"),
    home,
    pm2Home: join(home, "pm2"),
    piHome: join(home, "pi"),
    runtime: join(home, "runtime.json"),
    t3Home: join(home, "t3"),
  };
}

export function t3WorktreesRoot(paths: WorkerPaths): string {
  return join(paths.t3Home, "worktrees");
}

export function prepareWorker(paths: WorkerPaths): void {
  for (const path of [
    paths.home,
    paths.piHome,
    paths.pm2Home,
    paths.t3Home,
    t3WorktreesRoot(paths),
  ]) {
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

function frpcPlatformKey(): keyof typeof FRPC_ARCHIVE_SHA256 {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const architecture = process.arch === "arm64" ? "arm64" : "amd64";
  return `${platform}-${architecture}`;
}

export function verifyFileSha256(path: string, expected: string): void {
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `FRPC archive checksum mismatch: expected ${expected}, received ${actual}.`
    );
  }
}

export async function ensureFrpc(paths: WorkerPaths): Promise<void> {
  if (
    existsSync(paths.frpc) &&
    existsSync(paths.frpcVersion) &&
    readFileSync(paths.frpcVersion, "utf8").trim() === FRPC_VERSION
  ) {
    return;
  }
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
  const archive = frpcArchiveName(FRPC_VERSION);
  const archivePath = join(paths.home, archive);
  const extractPath = join(paths.home, `.frp-${FRPC_VERSION}-${Date.now()}`);
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
        `https://github.com/fatedier/frp/releases/download/v${FRPC_VERSION}/${archive}`,
      ],
      stderr: "inherit",
      stdout: "inherit",
    });
    if ((await download.exited) !== 0) {
      throw new Error(`Could not download ${archive}.`);
    }
    verifyFileSha256(archivePath, FRPC_ARCHIVE_SHA256[frpcPlatformKey()]);
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
    writeFileSync(paths.frpcVersion, `${FRPC_VERSION}\n`);
  } finally {
    rmSync(archivePath, { force: true });
    rmSync(extractPath, { force: true, recursive: true });
  }
}

function allowedSessionRoots(
  paths: WorkerPaths,
  cwd: string,
  allowedRoots: string
): string {
  return Array.from(
    new Set([
      ...(allowedRoots.trim().length > 0 ? allowedRoots : cwd)
        .split(",")
        .map((root) => root.trim())
        .filter((root) => root.length > 0),
      t3WorktreesRoot(paths),
    ])
  ).join(",");
}

export function workerProcessSpecs(
  paths: WorkerPaths,
  cwd: string,
  packageRoot: string,
  frpcConfig: string | undefined,
  allowedRoots = cwd
): readonly WorkerProcessSpec[] {
  const specs: WorkerProcessSpec[] = [
    {
      command: [process.execPath, join(packageRoot, "src", "server.ts")],
      cwd,
      env: {
        PI_ALLOWED_ROOTS: allowedSessionRoots(paths, cwd, String(allowedRoots)),
        PI_CWD: cwd,
        PI_OPENCODE_HOST: "127.0.0.1",
        PI_OPENCODE_PORT: String(SHIM_PORT),
        PI_SESSION_DIR: paths.piHome,
      },
      id: "shim",
      name: "t3-fauxpencode-shim",
    },
    {
      command: ["bash", join(packageRoot, "tools", "run-t3-shim.sh")],
      cwd,
      env: {
        PI_OPENCODE_URL: `http://127.0.0.1:${SHIM_PORT}`,
        T3_HOME: paths.t3Home,
      },
      id: "t3",
      name: "t3-fauxpencode-t3",
    },
  ];
  if (frpcConfig !== undefined) {
    specs.push({
      command: [paths.frpc, "-c", frpcConfig],
      cwd,
      env: {},
      id: "frpc",
      name: "t3-fauxpencode-frpc",
    });
  }
  return specs;
}

export function writeEcosystem(
  paths: WorkerPaths,
  cwd: string,
  packageRoot: string,
  frpcConfig: string | undefined,
  allowedRoots = cwd
): void {
  // PM2 and foreground mode consume the same process graph.
  const apps = workerProcessSpecs(
    paths,
    cwd,
    packageRoot,
    frpcConfig,
    allowedRoots
  ).map((spec) => {
    const [script, ...args] = spec.command;
    return {
      args,
      autorestart: true,
      cwd: spec.cwd,
      env: spec.env,
      exec_interpreter: "none",
      name: spec.name,
      script,
      watch: false,
    };
  });
  writeFileSync(
    paths.ecosystem,
    `module.exports = ${JSON.stringify({ apps }, null, 2)};\n`
  );
}
