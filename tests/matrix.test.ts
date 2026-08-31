import { describe, expect, test } from "bun:test";

import type { JsonValue } from "../src/types.ts";
import { decodeMatrix, loadMatrix } from "../tools/contract/matrix.ts";

describe("contract matrix", () => {
  test("starts explicitly pending until a reference corpus exists", async () => {
    const matrix = await loadMatrix();
    expect(matrix.status).toBe("pending-reference-capture");
    expect(matrix.rows).toHaveLength(0);
  });

  test("rejects hypotheses in a frozen matrix", () => {
    expect(() =>
      decodeMatrix({
        corpusId: "corpus",
        rows: [
          {
            confidence: "hypothesis",
            errorBehavior: "none",
            evidence: ["capture"],
            events: [],
            id: "OC-T3-0001",
            normalization: [],
            operation: "health",
            request: {},
            response: {},
            stateEffect: {},
            scenario: "C01",
            support: "required",
            trigger: "startup",
          },
        ],
        schemaVersion: 1,
        status: "frozen",
      } as unknown as JsonValue)
    ).toThrow("cannot be a hypothesis");
  });
});
