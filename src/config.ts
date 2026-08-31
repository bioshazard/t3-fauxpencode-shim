import type { Environment, ShimConfig } from "./types.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4096;
const DEFAULT_PROVIDER = "pi";
const DEFAULT_MODEL = "configured";
const SERVICE_VERSION = "0.1.0-poc";

function configuredPort(value: string | undefined): number {
  if (value === undefined || value.length === 0) return DEFAULT_PORT;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65_536
    ? port
    : DEFAULT_PORT;
}

export function loadConfig(environment: Environment = Bun.env): ShimConfig {
  return {
    agentDir: environment.PI_AGENT_DIR,
    cwd: environment.PI_CWD ?? process.cwd(),
    host: environment.PI_OPENCODE_HOST ?? DEFAULT_HOST,
    modelId: environment.PI_MODEL ?? DEFAULT_MODEL,
    port: configuredPort(environment.PI_OPENCODE_PORT),
    providerId: environment.PI_PROVIDER ?? DEFAULT_PROVIDER,
    version: SERVICE_VERSION,
  };
}
