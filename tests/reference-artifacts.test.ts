import { describe, expect, test } from "bun:test";

import {
  REQUIRED_REFERENCE_SCENARIOS,
  decodeReferenceManifest,
  validateCompletedScenarioReport,
} from "../tools/contract/reference-artifacts.ts";

function report(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    corpusId: "corpus",
    generatedAt: "2026-08-31T12:00:00.000Z",
    runId: "run",
    scenarios: REQUIRED_REFERENCE_SCENARIOS.map((id) => ({
      expectedTerminal: "terminal",
      failures: [],
      id,
      observedEventTypes: [],
      operations: [{ body: null, method: "GET", path: "/", status: 200 }],
      passed: true,
    })),
    status: "completed",
    ...overrides,
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

describe("reference artifact validation", () => {
  test("accepts a complete passed report", () => {
    expect(
      validateCompletedScenarioReport(report(), {
        corpusId: "corpus",
        runId: "run",
      }).scenarios
    ).toHaveLength(19);
  });

  test("rejects partial, stale, and duplicate reports", () => {
    expect(() =>
      validateCompletedScenarioReport(report({ status: "partial" }), {
        corpusId: "corpus",
        runId: "run",
      })
    ).toThrow("not completed");
    expect(() =>
      validateCompletedScenarioReport(report({ runId: "old-run" }), {
        corpusId: "corpus",
        runId: "run",
      })
    ).toThrow("runId does not match");
    expect(() =>
      validateCompletedScenarioReport(
        report({
          scenarios: [
            ...((report().scenarios as unknown[]) ?? []),
            {
              expectedTerminal: "terminal",
              failures: [],
              id: "C01",
              observedEventTypes: [],
              operations: [
                { body: null, method: "GET", path: "/", status: 200 },
              ],
              passed: true,
            },
          ],
        }),
        { corpusId: "corpus", runId: "run" }
      )
    ).toThrow("repeats C01");
  });

  test("requires an explicit complete scenario set", () => {
    const scenarios = (
      report().scenarios as Array<Record<string, unknown>>
    ).filter((entry) => entry.id !== "C19");
    expect(() =>
      validateCompletedScenarioReport(report({ scenarios }), {
        corpusId: "corpus",
        runId: "run",
      })
    ).toThrow("missing C19");
  });

  test("rejects forged scenario evidence", () => {
    const scenarios = [
      ...(report().scenarios as Array<Record<string, unknown>>),
    ];
    scenarios[0] = {
      ...scenarios[0],
      operations: [{ method: "GET", path: "/", status: 200 }],
    };
    expect(() =>
      validateCompletedScenarioReport(report({ scenarios }), {
        corpusId: "corpus",
        runId: "run",
      })
    ).toThrow("body must be string or null");
  });

  test("validates the reference manifest shape", () => {
    expect(
      decodeReferenceManifest({
        capturePath: "artifacts/raw/corpus.jsonl",
        captureSha256: "a".repeat(64),
        client: "stock-t3-opencode-adapter",
        corpusId: "corpus",
        generatedAt: "2026-08-31T12:00:00.000Z",
        openCodeCommit: "b".repeat(40),
        opencodeArgv: ["opencode", "serve"],
        provenance: provenance(),
        runId: "run",
        scenarioSha256: "c".repeat(64),
        scenarioOutput: "artifacts/runs/corpus.json",
        status: "passed",
        t3Commit: "d".repeat(40),
        t3Argv: ["pnpm", "test"],
      }).status
    ).toBe("passed");
    expect(() =>
      decodeReferenceManifest({
        capturePath: "capture",
        client: "raw-fetch-driver",
        corpusId: "corpus",
        generatedAt: "2026-08-31T12:00:00.000Z",
        openCodeCommit: "b".repeat(40),
        opencodeArgv: ["opencode"],
        runId: "run",
        status: "passed",
        t3Commit: "d".repeat(40),
        captureSha256: "a".repeat(64),
        scenarioSha256: "c".repeat(64),
        t3Argv: ["pnpm", "test"],
      })
    ).toThrow("client is invalid");
  });
});
