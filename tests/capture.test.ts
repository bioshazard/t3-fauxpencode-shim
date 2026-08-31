import { describe, expect, test } from "bun:test";

import { validateCaptureRecords } from "../tools/contract/capture.ts";

function record(sequence: number): Record<string, unknown> {
  return {
    body: {
      request: null,
      requestTruncated: false,
      response: "ok",
      responseTruncated: false,
    },
    connection: {
      closedAt: "2026-08-31T12:00:00.000Z",
      reason: "normal",
      state: "closed",
    },
    correlation: {
      "x-contract-run-id": "run-1",
      "x-contract-scenario": "C01",
    },
    durationMs: 1,
    request: { headers: {}, method: "GET", path: "/health", query: {} },
    response: { headers: {}, status: 200 },
    sequence,
    startedAt: "2026-08-31T12:00:00.000Z",
  };
}

describe("capture validation", () => {
  test("accepts ordered records", () => {
    expect(validateCaptureRecords([record(1), record(2)])).toHaveLength(2);
  });

  test("rejects duplicate sequence numbers", () => {
    expect(() => validateCaptureRecords([record(1), record(1)])).toThrow(
      "sequence must increase monotonically"
    );
  });

  test("rejects unredacted credentials", () => {
    const value = record(1);
    value.body = {
      ...(value.body as Record<string, unknown>),
      response: "Bearer secret-value",
    };
    expect(() => validateCaptureRecords([value])).toThrow(
      "unredacted authorization"
    );
  });
});
