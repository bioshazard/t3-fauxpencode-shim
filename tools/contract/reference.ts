import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadCapture } from "./capture.ts";
import { createCaptureHandler, makeCaptureConfig } from "./recorder.ts";
import {
  REQUIRED_REFERENCE_SCENARIOS,
  decodeReferenceManifest,
  isRecordValue,
  isStringValue,
  sha256File,
  type ReferenceProvenance,
  type ReferenceManifest,
  validateReferenceCorrelations,
  validateCompletedScenarioReport,
} from "./reference-artifacts.ts";

interface ReferenceConfig {
  readonly capturePath: string;
  readonly corpusId: string;
  readonly healthTimeoutMs: number;
  readonly openCodeRoot: string;
  readonly opencodeBin: string;
  readonly opencodeArgv: readonly string[];
  readonly outputPath: string;
  readonly t3Root: string;
  readonly t3Argv: readonly string[];
  readonly timeoutMs: number;
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
    !parsed.every(isStringValue) ||
    parsed.some((part) => part.trim().length === 0)
  )
    throw new Error(`${name} must be a non-empty JSON array of argv strings.`);
  return parsed;
}

function replacePort(argv: readonly string[], port: number): readonly string[] {
  return argv.map((part) => part.replaceAll("%PORT%", String(port)));
}

function requiredEnv(name: string): string {
  const value = Bun.env[name];
  if (value === undefined || value.trim().length === 0)
    throw new Error(`${name} is required.`);
  return value;
}

async function captureProvenance(): Promise<ReferenceProvenance> {
  const manifest = (await Bun.file(
    new URL("../../contracts/manifest.json", import.meta.url)
  ).json()) as unknown;
  if (!isRecordValue(manifest) || !isRecordValue(manifest.subjects))
    throw new Error("Pinned manifest is invalid.");
  const subjects = manifest.subjects;
  const readSubject = (
    value: unknown,
    name: string,
    packageKey: string,
    versionKey: string
  ): {
    readonly package: string;
    readonly packageManager: string;
    readonly packageVersion: string;
    readonly repository: string;
  } => {
    if (!isRecordValue(value))
      throw new Error(`Pinned manifest subject ${name} is invalid.`);
    const packageName = value[packageKey];
    const packageVersion = value[versionKey];
    const packageManager = value.packageManager;
    const repository = value.repository;
    if (
      !isStringValue(packageName) ||
      !isStringValue(packageVersion) ||
      !isStringValue(packageManager) ||
      !isStringValue(repository)
    )
      throw new Error(`Pinned manifest subject ${name} lacks provenance.`);
    return {
      package: packageName,
      packageManager,
      packageVersion,
      repository,
    };
  };
  const t3Code = readSubject(
    subjects.t3Code,
    "t3Code",
    "package",
    "packageVersion"
  );
  const openCode = readSubject(
    subjects.openCode,
    "openCode",
    "sdkPackage",
    "sdkVersion"
  );
  if (!isRecordValue(subjects.pi))
    throw new Error("Pinned manifest Pi subject is invalid.");
  const piPackage = subjects.pi.package;
  const piVersion = subjects.pi.packageVersion;
  if (!isStringValue(piPackage) || !isStringValue(piVersion))
    throw new Error("Pinned manifest Pi subject lacks provenance.");
  const piRepository = subjects.pi.repository;
  return {
    model: {
      fixture: requiredEnv("REFERENCE_MODEL_FIXTURE"),
      model: requiredEnv("REFERENCE_MODEL"),
      provider: requiredEnv("REFERENCE_MODEL_PROVIDER"),
    },
    runtime: {
      architecture: process.arch,
      nodeVersion: requiredEnv("REFERENCE_NODE_VERSION"),
      operatingSystem: process.platform,
      packageManager: requiredEnv("REFERENCE_PACKAGE_MANAGER"),
    },
    subjects: {
      openCode,
      pi: {
        package: piPackage,
        packageVersion: piVersion,
        ...(isStringValue(piRepository) ? { repository: piRepository } : {}),
      },
      t3Code,
    },
  };
}

async function pinnedCommit(root: string, name: string): Promise<string> {
  const process = Bun.spawn({
    cmd: ["git", "-C", root, "rev-parse", "HEAD"],
    stderr: "pipe",
    stdout: "pipe",
  });
  const output = await new Response(process.stdout).text();
  const exitCode = await process.exited;
  if (exitCode !== 0)
    throw new Error(`${name} checkout is not a readable git worktree.`);
  return output.trim();
}

async function assertCleanCheckout(root: string, name: string): Promise<void> {
  const process = Bun.spawn({
    cmd: ["git", "-C", root, "status", "--porcelain", "--untracked-files=no"],
    stderr: "pipe",
    stdout: "pipe",
  });
  const output = await new Response(process.stdout).text();
  const exitCode = await process.exited;
  if (exitCode !== 0)
    throw new Error(`${name} checkout status could not be read.`);
  if (output.trim().length > 0)
    throw new Error(`${name} checkout has tracked changes; use a clean pin.`);
}

async function verifyPinnedCheckouts(
  t3Root: string,
  openCodeRoot: string
): Promise<{ readonly openCodeCommit: string; readonly t3Commit: string }> {
  const manifest = (await Bun.file(
    new URL("../../contracts/manifest.json", import.meta.url)
  ).json()) as unknown;
  if (!isRecordValue(manifest)) throw new Error("Pinned manifest is invalid.");
  const t3 =
    isRecordValue(manifest.subjects) && isRecordValue(manifest.subjects.t3Code)
      ? manifest.subjects.t3Code.commit
      : undefined;
  const openCode =
    isRecordValue(manifest.subjects) &&
    isRecordValue(manifest.subjects.openCode)
      ? manifest.subjects.openCode.commit
      : undefined;
  if (!isStringValue(t3) || !isStringValue(openCode))
    throw new Error("Pinned manifest is missing upstream commits.");
  const [actualT3, actualOpenCode] = await Promise.all([
    pinnedCommit(t3Root, "T3"),
    pinnedCommit(openCodeRoot, "OpenCode"),
  ]);
  await Promise.all([
    assertCleanCheckout(t3Root, "T3"),
    assertCleanCheckout(openCodeRoot, "OpenCode"),
  ]);
  if (actualT3 !== t3)
    throw new Error(`T3 checkout is ${actualT3}, expected pinned ${t3}.`);
  if (actualOpenCode !== openCode)
    throw new Error(
      `OpenCode checkout is ${actualOpenCode}, expected pinned ${openCode}.`
    );
  return { openCodeCommit: actualOpenCode, t3Commit: actualT3 };
}

async function validateScenarioOutput(
  path: string,
  corpusId: string,
  runId: string,
  startedAtMs: number
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.file(path).text()) as unknown;
  } catch {
    throw new Error(`Scenario report ${path} is missing or invalid JSON.`);
  }
  if (Bun.file(path).lastModified < startedAtMs)
    throw new Error(`Scenario report ${path} predates this reference run.`);
  validateCompletedScenarioReport(parsed, { corpusId, runId });
}

async function configFromEnv(): Promise<ReferenceConfig> {
  const corpusId = Bun.env.CORPUS_ID;
  if (corpusId === undefined || corpusId.trim().length === 0)
    throw new Error("CORPUS_ID is required.");
  if (Bun.env.REFERENCE_T3_KIND !== "stock-t3-opencode-adapter")
    throw new Error(
      "REFERENCE_T3_KIND must be stock-t3-opencode-adapter for the reference gate."
    );
  const outputPath =
    Bun.env.REFERENCE_OUTPUT ?? `artifacts/runs/${corpusId}.reference.json`;
  const opencodeArgv = readArgv("REFERENCE_OPENCODE_ARGV");
  if (!opencodeArgv.some((part) => part.includes("%OPENCODE_BIN%")))
    throw new Error(
      "REFERENCE_OPENCODE_ARGV must include %OPENCODE_BIN% so the pinned OpenCode binary is executed."
    );
  if (!opencodeArgv.some((part) => part.includes("%PORT%")))
    throw new Error(
      "REFERENCE_OPENCODE_ARGV must include %PORT% so the supervisor can isolate the server."
    );
  return {
    capturePath: Bun.env.CAPTURE_OUTPUT ?? `artifacts/raw/${corpusId}.jsonl`,
    corpusId,
    healthTimeoutMs: Number(Bun.env.REFERENCE_HEALTH_TIMEOUT_MS ?? 30_000),
    openCodeRoot: requiredEnv("OPENCODE_REFERENCE_ROOT"),
    opencodeBin: requiredEnv("OPENCODE_REFERENCE_BIN"),
    opencodeArgv,
    outputPath,
    t3Root: requiredEnv("T3_REFERENCE_ROOT"),
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
  const pinned = await verifyPinnedCheckouts(
    config.t3Root,
    config.openCodeRoot
  );
  const opencodeBin = resolve(config.openCodeRoot, config.opencodeBin);
  if (!opencodeBin.startsWith(`${resolve(config.openCodeRoot)}/`))
    throw new Error(
      "OPENCODE_REFERENCE_BIN must be inside the pinned checkout."
    );
  if (!(await Bun.file(opencodeBin).exists()))
    throw new Error(`OpenCode executable does not exist: ${opencodeBin}`);
  const reserved = reservePort();
  const opencodeArgv = replacePort(
    config.opencodeArgv.map((part) =>
      part.replaceAll("%OPENCODE_BIN%", opencodeBin)
    ),
    reserved.port
  );
  reserved.release();
  const runId = crypto.randomUUID();
  const startedAtMs = Date.now();
  const opencode = Bun.spawn({
    cmd: [...opencodeArgv],
    cwd: config.openCodeRoot,
    stderr: "inherit",
    stdout: "inherit",
  });
  const captureConfig = makeCaptureConfig(
    `http://127.0.0.1:${reserved.port}`,
    config.capturePath,
    Number(Bun.env.CAPTURE_MAX_BODY_BYTES ?? 8 * 1024 * 1024),
    runId
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
    CONTRACT_RUN_ID: runId,
    OPENCODE_BASE_URL: recorder.url.toString(),
    SCENARIO_OUTPUT: scenarioOutput,
  };
  let status: "failed" | "passed" = "failed";
  let captureSha256: string | undefined;
  let scenarioSha256: string | undefined;
  let provenance: ReferenceProvenance | undefined;
  const writeManifest = async (): Promise<ReferenceManifest> => {
    const manifest: ReferenceManifest = {
      ...(captureSha256 === undefined ? {} : { captureSha256 }),
      capturePath: config.capturePath,
      client: "stock-t3-opencode-adapter",
      corpusId: config.corpusId,
      generatedAt: new Date().toISOString(),
      openCodeCommit: pinned.openCodeCommit,
      opencodeArgv,
      ...(provenance === undefined ? {} : { provenance }),
      runId,
      ...(scenarioSha256 === undefined ? {} : { scenarioSha256 }),
      scenarioOutput,
      status,
      t3Commit: pinned.t3Commit,
      t3Argv: config.t3Argv,
    };
    decodeReferenceManifest(manifest);
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
      cwd: config.t3Root,
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
    const records = await loadCapture(config.capturePath);
    const capturedScenarios = validateReferenceCorrelations(records, runId);
    for (const scenario of REQUIRED_REFERENCE_SCENARIOS) {
      if (!capturedScenarios.has(scenario))
        throw new Error(
          `Capture is missing scenario correlation for ${scenario}.`
        );
    }
    await validateScenarioOutput(
      scenarioOutput,
      config.corpusId,
      runId,
      startedAtMs
    );
    provenance = await captureProvenance();
    captureSha256 = await sha256File(config.capturePath);
    scenarioSha256 = await sha256File(scenarioOutput);
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
  const manifest = await runReference(await configFromEnv());
  console.log(
    `reference run ${manifest.status}; wrote ${Bun.env.REFERENCE_OUTPUT ?? "artifacts/runs/<corpus>.reference.json"}`
  );
}
