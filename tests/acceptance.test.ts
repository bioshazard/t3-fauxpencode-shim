import { describe, expect, test } from "bun:test";

import {
  assertPinnedT3Checkout,
  assertAcceptanceReport,
  assertEquivalentScenarioReports,
} from "../tools/contract/acceptance.ts";
import { REQUIRED_REFERENCE_SCENARIOS } from "../tools/contract/reference-artifacts.ts";

function report(status: "completed" | "partial" = "completed", passed = true) {
  return {
    baseUrl: "http://127.0.0.1:4096",
    corpusId: null,
    generatedAt: "2026-08-31T12:00:00.000Z",
    runId: "run",
    scenarios: REQUIRED_REFERENCE_SCENARIOS.map((id) => ({
      applicability: "required" as const,
      canonicalState: { id, source: "t3" },
      declaredState: { id, source: "fixture" },
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

  test("rejects runner-derived canonical state", () => {
    const derived = report();
    derived.scenarios[0].canonicalState = {
      id: "C01",
      source: "scenario-runner-derived",
    };
    expect(() => assertAcceptanceReport(derived)).toThrow("not T3-sourced");
  });

  test("compares operations, events, and T3 canonical state", () => {
    const reference = report();
    const shim = report();
    expect(() =>
      assertEquivalentScenarioReports(reference, shim)
    ).not.toThrow();

    Object.assign(shim.scenarios[0].operations[0], { body: "{}" });
    expect(() => assertEquivalentScenarioReports(reference, shim)).toThrow(
      "operation 1 differs for C01"
    );
  });

  test("does not treat null response bodies as wildcards", () => {
    const reference = report();
    const shim = report();
    Object.assign(shim.scenarios[0].operations[0], { body: "null" });
    expect(() => assertEquivalentScenarioReports(reference, shim)).toThrow(
      "operation 1 differs for C01"
    );
  });

  test("fails closed when a matrix normalization rule is present", () => {
    expect(() =>
      assertEquivalentScenarioReports(report(), report(), [
        {
          errorBehavior: "none",
          events: [],
          id: "OC-T3-0001",
          normalization: ["timestamp"],
          request: { method: "GET", path: "/" },
          response: { status: 200 },
          stateEffect: {},
          scenario: "C01",
          support: "required",
        },
      ])
    ).toThrow("normalization is not implemented");
  });

  test("rejects matrix behavior that differs from the selected operation", () => {
    expect(() =>
      assertEquivalentScenarioReports(report(), report(), [
        {
          errorBehavior: "none",
          events: [],
          id: "OC-T3-0001",
          normalization: [],
          request: { method: "GET", path: "/" },
          response: { status: 201 },
          stateEffect: {},
          scenario: "C01",
          support: "required",
        },
      ])
    ).toThrow("response status mismatches");
  });

  test("matches templated matrix paths to concrete scenario operations", () => {
    const reference = report();
    const shim = report();
    reference.scenarios[0].operations[0].path = "/session/reference-id";
    shim.scenarios[0].operations[0].path = "/session/shim-id";
    expect(() =>
      assertEquivalentScenarioReports(reference, shim, [
        {
          errorBehavior: "none",
          events: [],
          id: "OC-T3-0001",
          normalization: [],
          request: { method: "GET", path: "/session/{sessionID}" },
          response: { status: 200 },
          stateEffect: {},
          scenario: "C01",
          support: "required",
        },
      ])
    ).toThrow("operation 1 differs for C01");
  });

  test("fails closed for matrix fields absent from scenario reports", () => {
    expect(() =>
      assertEquivalentScenarioReports(report(), report(), [
        {
          errorBehavior: "none",
          events: [],
          id: "OC-T3-0001",
          normalization: [],
          request: { body: {}, method: "GET", path: "/" },
          response: { status: 200 },
          stateEffect: {},
          scenario: "C01",
          support: "required",
        },
      ])
    ).toThrow("fields not present");
  });

  test("rejects a T3 checkout at the wrong pinned commit", async () => {
    await expect(
      assertPinnedT3Checkout(process.cwd(), "0".repeat(40))
    ).rejects.toThrow("expected pinned");
  });
});
