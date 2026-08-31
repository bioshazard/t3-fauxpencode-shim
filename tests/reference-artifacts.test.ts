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
    scenarios: REQUIRED_REFERENCE_SCENARIOS.map((id) => ({ id, passed: true })),
    status: "completed",
    ...overrides,
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
            { id: "C01", passed: true },
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

  test("validates the reference manifest shape", () => {
    expect(
      decodeReferenceManifest({
        capturePath: "artifacts/raw/corpus.jsonl",
        client: "stock-t3-opencode-adapter",
        corpusId: "corpus",
        generatedAt: "2026-08-31T12:00:00.000Z",
        opencodeArgv: ["opencode", "serve"],
        runId: "run",
        status: "passed",
        t3Argv: ["pnpm", "test"],
      }).status
    ).toBe("passed");
    expect(() =>
      decodeReferenceManifest({
        capturePath: "capture",
        client: "raw-fetch-driver",
        corpusId: "corpus",
        generatedAt: "2026-08-31T12:00:00.000Z",
        opencodeArgv: ["opencode"],
        runId: "run",
        status: "passed",
        t3Argv: ["pnpm", "test"],
      })
    ).toThrow("client is invalid");
  });
});
