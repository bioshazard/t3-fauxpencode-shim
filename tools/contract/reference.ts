import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { loadCapture } from "./capture.ts";
import { createCaptureHandler, makeCaptureConfig } from "./recorder.ts";

interface ReferenceConfig {
  readonly capturePath: string;
  readonly corpusId: string;
  readonly healthTimeoutMs: number;
  readonly opencodeArgv: readonly string[];
  readonly outputPath: string;
  readonly t3Argv: readonly string[];
  readonly timeoutMs: number;
}

interface ReferenceManifest {
  readonly capturePath: string;
  readonly client: "stock-t3-opencode-adapter";
  readonly corpusId: string;
  readonly generatedAt: string;
  readonly opencodeArgv: readonly string[];
  readonly scenarioOutput?: string;
  readonly status: "failed" | "passed";
  readonly t3Argv: readonly string[];
}

function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isRecord(
  value: unknown
): value is { readonly [key: string]: unknown } {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function readArgv(name: string): readonly string[] {
  const raw = Bun.env[name];
  if (raw === undefined || raw.trim().length === 0)
    throw new Error(`${name} must be a JSON array of argv strings.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must contain valid JSON.`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(isString) ||
    parsed.some((part) => part.trim().length === 0)
  )
    throw new Error(`${name} must be a non-empty JSON array of argv strings.`);
  return parsed;
}

function replacePort(argv: readonly string[], port: number): readonly string[] {
  return argv.map((part) => part.replaceAll("%PORT%", String(port)));
}

async function validateScenarioOutput(path: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.file(path).text()) as unknown;
  } catch {
    throw new Error(`Scenario report ${path} is missing or invalid JSON.`);
  }
  if (!isRecord(parsed) || parsed.status !== "completed")
    throw new Error(`Scenario report ${path} is not completed.`);
  const scenarios = parsed.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length === 0)
    throw new Error(`Scenario report ${path} has no scenarios.`);
  if (
    scenarios.some(
      (scenario) => !isRecord(scenario) || scenario.passed !== true
    )
  )
    throw new Error(`Scenario report ${path} contains a failed scenario.`);
}

function configFromEnv(): ReferenceConfig {
  const corpusId = Bun.env.CORPUS_ID;
  if (corpusId === undefined || corpusId.trim().length === 0)
    throw new Error("CORPUS_ID is required.");
  if (Bun.env.REFERENCE_T3_KIND !== "stock-t3-opencode-adapter")
    throw new Error(
      "REFERENCE_T3_KIND must be stock-t3-opencode-adapter for the reference gate."
    );
  const outputPath =
    Bun.env.REFERENCE_OUTPUT ?? `artifacts/runs/${corpusId}.reference.json`;
  return {
    capturePath: Bun.env.CAPTURE_OUTPUT ?? `artifacts/raw/${corpusId}.jsonl`,
    corpusId,
    healthTimeoutMs: Number(Bun.env.REFERENCE_HEALTH_TIMEOUT_MS ?? 30_000),
    opencodeArgv: readArgv("REFERENCE_OPENCODE_ARGV"),
    outputPath,
    t3Argv: readArgv("REFERENCE_T3_ARGV"),
    timeoutMs: Number(Bun.env.REFERENCE_TIMEOUT_MS ?? 10 * 60_000),
  };
}

function assertDuration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer.`);
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/global/health", url));
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "request failed";
    }
    await Bun.sleep(100);
  }
  throw new Error(`OpenCode did not become healthy: ${lastError}`);
}

function reservePort(): {
  readonly port: number;
  readonly release: () => void;
} {
  const probe = Bun.serve({
    fetch: () => new Response(null, { status: 204 }),
    hostname: "127.0.0.1",
    port: 0,
  });
  if (probe.port === undefined) {
    probe.stop();
    throw new Error("Unable to reserve a local port.");
  }
  return { port: probe.port, release: () => probe.stop() };
}

async function runReference(
  config: ReferenceConfig
): Promise<ReferenceManifest> {
  assertDuration(config.healthTimeoutMs, "REFERENCE_HEALTH_TIMEOUT_MS");
  assertDuration(config.timeoutMs, "REFERENCE_TIMEOUT_MS");
  const reserved = reservePort();
  const opencodeArgv = replacePort(config.opencodeArgv, reserved.port);
  const opencode = Bun.spawn({
    cmd: [...opencodeArgv],
    stderr: "inherit",
    stdout: "inherit",
  });
  const captureConfig = makeCaptureConfig(
    `http://127.0.0.1:${reserved.port}`,
    config.capturePath,
    Number(Bun.env.CAPTURE_MAX_BODY_BYTES ?? 8 * 1024 * 1024)
  );
  const { handler, store } = createCaptureHandler(captureConfig);
  const recorder = Bun.serve({
    fetch: handler,
    hostname: "127.0.0.1",
    port: 0,
  });
  const scenarioOutput =
    Bun.env.REFERENCE_SCENARIO_OUTPUT ??
    `artifacts/runs/${config.corpusId}.json`;
  const t3Env: Record<string, string> = {
    ...process.env,
    CAPTURE_TARGET: recorder.url.toString(),
    CORPUS_ID: config.corpusId,
    OPENCODE_BASE_URL: `http://127.0.0.1:${reserved.port}`,
    SCENARIO_OUTPUT: scenarioOutput,
  };
  let status: "failed" | "passed" = "failed";
  const writeManifest = async (): Promise<ReferenceManifest> => {
    const manifest: ReferenceManifest = {
      capturePath: config.capturePath,
      client: "stock-t3-opencode-adapter",
      corpusId: config.corpusId,
      generatedAt: new Date().toISOString(),
      opencodeArgv,
      scenarioOutput,
      status,
      t3Argv: config.t3Argv,
    };
    await mkdir(dirname(config.outputPath), { recursive: true });
    await Bun.write(
      config.outputPath,
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    return manifest;
  };
  try {
    await waitForHealth(
      `http://127.0.0.1:${reserved.port}`,
      config.healthTimeoutMs
    );
    const t3 = Bun.spawn({
      cmd: [...config.t3Argv],
      env: t3Env,
      stderr: "inherit",
      stdout: "inherit",
    });
    const exitCode = await Promise.race([
      t3.exited,
      Bun.sleep(config.timeoutMs).then(() => -1),
    ]);
    if (exitCode === -1) {
      t3.kill();
      throw new Error("Stock T3 reference command timed out.");
    }
    if (exitCode !== 0)
      throw new Error(`Stock T3 reference command exited with ${exitCode}.`);
    await store.flush();
    await loadCapture(config.capturePath);
    await validateScenarioOutput(scenarioOutput);
    status = "passed";
  } catch (error) {
    await writeManifest();
    throw error;
  } finally {
    recorder.stop();
    reserved.release();
    opencode.kill();
  }
  return writeManifest();
}

if (import.meta.main) {
  const manifest = await runReference(configFromEnv());
  console.log(
    `reference run ${manifest.status}; wrote ${Bun.env.REFERENCE_OUTPUT ?? "artifacts/runs/<corpus>.reference.json"}`
  );
}
