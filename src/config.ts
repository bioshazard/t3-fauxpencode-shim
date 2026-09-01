import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Environment, ShimConfig } from "./types.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4096;
const DEFAULT_PROVIDER = "pi";
const DEFAULT_MODEL = "configured";
// T3 gates external OpenCode providers on this protocol dialect version.
const OPENCODE_COMPAT_VERSION = "1.14.19";

function configuredRoots(
  value: string | undefined,
  cwd: string
): readonly string[] {
  if (value === undefined || value.trim().length === 0) return [cwd];
  const roots = value.split(",").map((root) => root.trim());
  if (roots.some((root) => root.length === 0)) {
    throw new Error(
      "PI_ALLOWED_ROOTS must be a comma-separated list of directory paths."
    );
  }
  return roots;
}

function canonicalPath(value: string): string | null {
  try {
    return realpathSync(resolve(value));
  } catch {
    return null;
  }
}

export function canonicalAllowedCwd(
  cwd: string,
  roots: readonly string[]
): string | null {
  const canonicalCwd = canonicalPath(cwd);
  if (canonicalCwd === null) return null;
  const allowed = roots.some((root) => {
    const canonicalRoot = canonicalPath(root);
    if (canonicalRoot === null) return false;
    const relativeCwd = relative(canonicalRoot, canonicalCwd);
    return (
      relativeCwd === "" ||
      (relativeCwd !== ".." &&
        !relativeCwd.startsWith(`..${sep}`) &&
        !isAbsolute(relativeCwd))
    );
  });
  return allowed ? canonicalCwd : null;
}

export function isAllowedCwd(cwd: string, roots: readonly string[]): boolean {
  return canonicalAllowedCwd(cwd, roots) !== null;
}

export function normalizeConfig(config: ShimConfig): ShimConfig {
  if (Array.isArray(config.allowedRoots)) return config;
  return { ...config, allowedRoots: [config.cwd] };
}

function configuredPort(value: string | undefined): number {
  if (value === undefined || value.length === 0) return DEFAULT_PORT;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65_536
    ? port
    : DEFAULT_PORT;
}

export function loadConfig(environment: Environment = Bun.env): ShimConfig {
  const cwd = environment.PI_CWD ?? process.cwd();
  return {
    allowedRoots: configuredRoots(environment.PI_ALLOWED_ROOTS, cwd),
    agentDir: environment.PI_AGENT_DIR,
    cwd,
    host: environment.PI_OPENCODE_HOST ?? DEFAULT_HOST,
    modelId: environment.PI_MODEL ?? DEFAULT_MODEL,
    port: configuredPort(environment.PI_OPENCODE_PORT),
    providerId: environment.PI_PROVIDER ?? DEFAULT_PROVIDER,
    sessionDir: environment.PI_SESSION_DIR,
    version: OPENCODE_COMPAT_VERSION,
  };
}
