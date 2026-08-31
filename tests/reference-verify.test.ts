import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REQUIRED_REFERENCE_SCENARIOS } from "../tools/contract/reference-artifacts.ts";
import type { ScenarioReport } from "../tools/contract/reference-artifacts.ts";
import {
  validateScenarioOperations,
  verifyReferenceArtifacts,
} from "../tools/contract/reference-verify.ts";

const PINNED_CORPUS = "t3code-9b2d0431-opencode-9f69463f-pi-0.84.4";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scenarioEntry(id: string): Record<string, unknown> {
  return {
    applicability: "required",
    canonicalState: { id, source: "t3" },
    declaredState: { id, source: "fixture" },
    expectedTerminal: "terminal",
    failures: [],
    id,
    observedEventTypes: [],
    operations: [{ body: "{}", method: "GET", path: "/", status: 200 }],
    passed: true,
  };
}

function provenance(): Record<string, unknown> {
  return {
    model: { fixture: "fixture", model: "model", provider: "provider" },
    runtime: {
      architecture: "arm64",
      nodeVersion: "v24.13.1",
      operatingSystem: "darwin",
      packageManager: "pnpm@11.10.0",
    },
    subjects: {
      openCode: {
        package: "@opencode-ai/sdk",
        packageManager: "bun@1.3.14",
        packageVersion: "1.18.25",
        repository: "https://github.com/anomalyco/opencode.git",
      },
      pi: {
        package: "@earendil-works/pi-coding-agent",
        packageVersion: "0.84.4",
        repository: "https://github.com/earendil-works/pi.git",
      },
      t3Code: {
        package: "t3",
        packageManager: "pnpm@11.10.0",
        packageVersion: "0.0.37",
        repository: "https://github.com/pingdotgg/t3code.git",
      },
    },
  };
}

function captureRecord(
  scenario = "C01",
  sequence = 1,
  response: string | null = "{}"
): {
  readonly body: {
    readonly response: string | null;
    readonly [key: string]: unknown;
  };
  readonly correlation: Readonly<Record<string, string>>;
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly [key: string]: unknown;
  };
  readonly response: {
    readonly status: number;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
} {
  return {
    body: {
      request: null,
      requestTruncated: false,
      response,
      responseTruncated: false,
    },
    connection: {
      closedAt: "2026-08-31T12:00:00.000Z",
      reason: "normal",
      state: "closed",
    },
    correlation: {
      "x-contract-run-id": "run",
      "x-contract-scenario": scenario,
    },
    durationMs: 1,
    request: { headers: {}, method: "GET", path: "/", query: {} },
    response: { headers: {}, status: 200 },
    sequence,
    startedAt: "2026-08-31T12:00:00.000Z",
  };
}

function operationReport(body: string | null): ScenarioReport {
  return {
    scenarios: [
      {
        ...scenarioEntry("C01"),
        operations: [{ body, method: "GET", path: "/", status: 200 }],
      },
    ],
  } as unknown as ScenarioReport;
}

describe("reference corpus verification", () => {
  test("treats a null operation body as an exact empty-body observation", () => {
    expect(() =>
      validateScenarioOperations(operationReport(null), [
        captureRecord("C01", 1, "{}"),
      ])
    ).toThrow("operation 1");
    expect(() =>
      validateScenarioOperations(operationReport("{}"), [
        captureRecord("C01", 1, null),
      ])
    ).toThrow("operation 1");
    expect(() =>
      validateScenarioOperations(operationReport(null), [
        captureRecord("C01", 1, null),
      ])
    ).not.toThrow();
  });

  test("verifies a passed manifest and detects tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "reference-verify-"));
    const capturePath = join(root, "capture.jsonl");
    const scenarioPath = join(root, "scenarios.json");
    const manifestPath = join(root, "manifest.json");
    const capture = `${REQUIRED_REFERENCE_SCENARIOS.map((scenario, index) =>
      JSON.stringify(captureRecord(scenario, index + 1))
    ).join("\n")}\n`;
    const scenario = JSON.stringify({
      corpusId: PINNED_CORPUS,
      generatedAt: "2026-08-31T12:00:00.000Z",
      runId: "run",
      scenarios: REQUIRED_REFERENCE_SCENARIOS.map(scenarioEntry),
      status: "completed",
    });
    await Bun.write(capturePath, capture);
    await Bun.write(scenarioPath, scenario);
    await Bun.write(
      manifestPath,
      JSON.stringify({
        capturePath,
        captureSha256: digest(capture),
        client: "stock-t3-opencode-adapter",
        corpusId: PINNED_CORPUS,
        generatedAt: "2026-08-31T12:00:00.000Z",
        openCodeCommit: "9f69463f1d556af2b5b51d2efa1c04f5f544f911",
        opencodeArgv: ["opencode", "serve"],
        provenance: provenance(),
        runId: "run",
        scenarioOutput: scenarioPath,
        scenarioSha256: digest(scenario),
        status: "passed",
        t3Argv: ["pnpm", "test"],
        t3Commit: "9b2d04317c68233782e0630464ac86d77d0686f3",
      })
    );

    expect((await verifyReferenceArtifacts(manifestPath)).corpusId).toBe(
      PINNED_CORPUS
    );
    await Bun.write(scenarioPath, `${scenario} `);
    await expect(verifyReferenceArtifacts(manifestPath)).rejects.toThrow(
      "scenario checksum mismatch"
    );
  });

  test("rejects a report whose scenarios are missing from raw capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "reference-verify-coverage-"));
    const capturePath = join(root, "capture.jsonl");
    const scenarioPath = join(root, "scenarios.json");
    const manifestPath = join(root, "manifest.json");
    const capture = `${JSON.stringify(captureRecord("C01"))}\n`;
    const scenario = JSON.stringify({
      corpusId: PINNED_CORPUS,
      generatedAt: "2026-08-31T12:00:00.000Z",
      runId: "run",
      scenarios: REQUIRED_REFERENCE_SCENARIOS.map(scenarioEntry),
      status: "completed",
    });
    await Bun.write(capturePath, capture);
    await Bun.write(scenarioPath, scenario);
    await Bun.write(
      manifestPath,
      JSON.stringify({
        capturePath,
        captureSha256: digest(capture),
        client: "stock-t3-opencode-adapter",
        corpusId: PINNED_CORPUS,
        generatedAt: "2026-08-31T12:00:00.000Z",
        openCodeCommit: "9f69463f1d556af2b5b51d2efa1c04f5f544f911",
        opencodeArgv: ["opencode", "serve"],
        provenance: provenance(),
        runId: "run",
        scenarioOutput: scenarioPath,
        scenarioSha256: digest(scenario),
        status: "passed",
        t3Argv: ["pnpm", "test"],
        t3Commit: "9b2d04317c68233782e0630464ac86d77d0686f3",
      })
    );

    await expect(verifyReferenceArtifacts(manifestPath)).rejects.toThrow(
      "missing raw capture for C02"
    );
  });

  test("rejects a passed manifest with identities other than the pinned corpus", async () => {
    const root = await mkdtemp(join(tmpdir(), "reference-verify-identity-"));
    const capturePath = join(root, "capture.jsonl");
    const scenarioPath = join(root, "scenarios.json");
    const manifestPath = join(root, "manifest.json");
    const capture = `${REQUIRED_REFERENCE_SCENARIOS.map((scenario, index) =>
      JSON.stringify(captureRecord(scenario, index + 1))
    ).join("\n")}\n`;
    const scenario = JSON.stringify({
      corpusId: PINNED_CORPUS,
      generatedAt: "2026-08-31T12:00:00.000Z",
      runId: "run",
      scenarios: REQUIRED_REFERENCE_SCENARIOS.map(scenarioEntry),
      status: "completed",
    });
    await Bun.write(capturePath, capture);
    await Bun.write(scenarioPath, scenario);
    await Bun.write(
      manifestPath,
      JSON.stringify({
        capturePath,
        captureSha256: digest(capture),
        client: "stock-t3-opencode-adapter",
        corpusId: PINNED_CORPUS,
        generatedAt: "2026-08-31T12:00:00.000Z",
        openCodeCommit: "b".repeat(40),
        opencodeArgv: ["opencode", "serve"],
        provenance: provenance(),
        runId: "run",
        scenarioOutput: scenarioPath,
        scenarioSha256: digest(scenario),
        status: "passed",
        t3Argv: ["pnpm", "test"],
        t3Commit: "d".repeat(40),
      })
    );

    await expect(verifyReferenceArtifacts(manifestPath)).rejects.toThrow(
      "does not match pinned corpus"
    );
  });

  test("rejects capture records with unknown scenario labels", async () => {
    const root = await mkdtemp(join(tmpdir(), "reference-verify-unknown-"));
    const capturePath = join(root, "capture.jsonl");
    const scenarioPath = join(root, "scenarios.json");
    const manifestPath = join(root, "manifest.json");
    const capture = `${JSON.stringify({
      ...captureRecord(),
      correlation: {
        "x-contract-run-id": "run",
        "x-contract-scenario": "C99",
      },
    })}\n`;
    const scenario = JSON.stringify({
      corpusId: PINNED_CORPUS,
      generatedAt: "2026-08-31T12:00:00.000Z",
      runId: "run",
      scenarios: REQUIRED_REFERENCE_SCENARIOS.map(scenarioEntry),
      status: "completed",
    });
    await Bun.write(capturePath, capture);
    await Bun.write(scenarioPath, scenario);
    await Bun.write(
      manifestPath,
      JSON.stringify({
        capturePath,
        captureSha256: digest(capture),
        client: "stock-t3-opencode-adapter",
        corpusId: PINNED_CORPUS,
        generatedAt: "2026-08-31T12:00:00.000Z",
        openCodeCommit: "9f69463f1d556af2b5b51d2efa1c04f5f544f911",
        opencodeArgv: ["opencode", "serve"],
        provenance: provenance(),
        runId: "run",
        scenarioOutput: scenarioPath,
        scenarioSha256: digest(scenario),
        status: "passed",
        t3Argv: ["pnpm", "test"],
        t3Commit: "9b2d04317c68233782e0630464ac86d77d0686f3",
      })
    );

    await expect(verifyReferenceArtifacts(manifestPath)).rejects.toThrow(
      "known scenario"
    );
  });
});
