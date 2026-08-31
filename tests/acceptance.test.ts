import { describe, expect, test } from "bun:test";

import { assertAcceptanceReport } from "../tools/contract/acceptance.ts";

function report(status: "completed" | "partial" = "completed", passed = true) {
  return {
    baseUrl: "http://127.0.0.1:4096",
    corpusId: null,
    generatedAt: "2026-08-31T12:00:00.000Z",
    runId: "run",
    scenarios: [
      {
        applicability: "required" as const,
        canonicalState: {},
        declaredState: {},
        expectedTerminal: "done",
        failures: passed ? [] : ["failed"],
        id: "C01",
        observedEventTypes: [],
        operations: [{ body: null, method: "GET", path: "/", status: 200 }],
        passed,
      },
    ],
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
