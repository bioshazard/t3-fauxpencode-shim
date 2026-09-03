import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type FrpcProxy = { readonly customDomains?: unknown; readonly type?: unknown };
type FrpcConfig = { readonly proxies?: unknown };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Object.prototype.toString.call(value) === "[object Object]"
    ? (value as Record<string, unknown>)
    : undefined;
}

function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

const configPath = process.env.PI_FRPC_CONFIG ?? join(homedir(), "frpc.toml");
const config = Bun.TOML.parse(readFileSync(configPath, "utf8")) as FrpcConfig;
const proxy = (Array.isArray(config.proxies) ? config.proxies : [])
  .map(asRecord)
  .find((value): value is FrpcProxy => value?.type === "http");
const hostname = Array.isArray(proxy?.customDomains)
  ? proxy.customDomains.find(isString)
  : undefined;
if (hostname === undefined) {
  throw new Error(`No HTTP customDomains entry in ${configPath}.`);
}

const baseUrl = process.env.T3_PUBLIC_URL ?? `https://${hostname}`;
const baseDir =
  process.env.T3_HOME ??
  resolve(import.meta.dir, "..", "artifacts/t3-shim-home");

console.log(`Public URL: ${baseUrl}`);
console.log("Fresh pairing token:");
const pair = Bun.spawn({
  cmd: [
    "bunx",
    `t3@${process.env.T3_VERSION ?? "0.0.37"}`,
    "auth",
    "pairing",
    "create",
    "--base-dir",
    baseDir,
    "--base-url",
    baseUrl,
  ],
  stderr: "inherit",
  stdout: "inherit",
});
if ((await pair.exited) !== 0)
  throw new Error("Could not create pairing token.");
