import { describe, expect, test } from "bun:test";

import { assertAcceptanceReport } from "../tools/contract/acceptance.ts";
import { REQUIRED_REFERENCE_SCENARIOS } from "../tools/contract/reference-artifacts.ts";

function report(status: "completed" | "partial" = "completed", passed = true) {
  return {
    baseUrl: "http://127.0.0.1:4096",
    corpusId: null,
    generatedAt: "2026-08-31T12:00:00.000Z",
    runId: "run",
    scenarios: REQUIRED_REFERENCE_SCENARIOS.map((id) => ({
      applicability: "required" as const,
      canonicalState: { id },
      declaredState: { id },
      expectedTerminal: "done",
      failures: passed && id === "C01" ? [] : passed ? [] : ["failed"],
      id,
      observedEventTypes: [],
      operations: [{ body: null, method: "GET", path: "/", status: 200 }],
      passed: passed || id !== "C01",
    })),
    status,
  };
}

describe("shim acceptance gate", () => {
  test("accepts a completed scenario report", () => {
    expect(() => assertAcceptanceReport(report())).not.toThrow();
  });

  test("rejects partial and failed reports", () => {
    expect(() => assertAcceptanceReport(report("partial"))).toThrow("partial");
    expect(() => assertAcceptanceReport(report("completed", false))).toThrow(
      "C01"
    );
  });
});
