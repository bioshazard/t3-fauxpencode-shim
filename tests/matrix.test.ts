import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "../src/types.ts";
import {
  assertMatrixCorpus,
  decodeMatrix,
  loadMatrix,
  type Matrix,
  validateMatrixEvidence,
} from "../tools/contract/matrix.ts";
import { REQUIRED_REFERENCE_SCENARIOS } from "../tools/contract/reference-artifacts.ts";
import type { ReferenceProvenance } from "../tools/contract/reference-artifacts.ts";

const PINNED_CORPUS = "t3code-9b2d0431-opencode-9f69463f-pi-0.84.4";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function provenance(): ReferenceProvenance {
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
  scenario: string,
  sequence: number
): Record<string, unknown> {
  return {
    body: {
      request: JSON.stringify({ title: "hello" }),
      requestTruncated: false,
      response: JSON.stringify({ ok: true }),
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
    request: {
      headers: { accept: "application/json" },
      method: "GET",
      path: "/global/health",
      query: {},
      body: { title: "hello" },
    },
    response: { headers: { "content-type": "application/json" }, status: 200 },
    sequence,
    startedAt: "2026-08-31T12:00:00.000Z",
  };
}

function scenarioEntry(
  id: string,
  applicability: "required" | "not-applicable" = "required"
): Record<string, unknown> {
  return {
    applicability,
    canonicalState: { id, source: "t3" },
    declaredState: { id, source: "fixture" },
    expectedTerminal: "done",
    failures: [],
    id,
    observedEventTypes: [],
    operations: [
      { body: "{}", method: "GET", path: "/global/health", status: 200 },
    ],
    passed: true,
    ...(applicability === "not-applicable"
      ? { skipReason: "fixture does not exercise this scenario" }
      : {}),
  };
}

async function verifiedFixture(notApplicableScenario?: string): Promise<{
  readonly capturePath: string;
  readonly manifest: Parameters<typeof validateMatrixEvidence>[1];
}> {
  const root = await mkdtemp(join(tmpdir(), "matrix-evidence-"));
  const capturePath = join(root, "capture.jsonl");
  const scenarioPath = join(root, "scenarios.json");
  const capture = `${REQUIRED_REFERENCE_SCENARIOS.map((id, index) =>
    JSON.stringify(captureRecord(id, index + 1))
  ).join("\n")}\n`;
  const scenario = JSON.stringify({
    corpusId: PINNED_CORPUS,
    runId: "run",
    scenarios: REQUIRED_REFERENCE_SCENARIOS.map((id) =>
      scenarioEntry(
        id,
        id === notApplicableScenario ? "not-applicable" : "required"
      )
    ),
    status: "completed",
  });
  await Bun.write(capturePath, capture);
  await Bun.write(scenarioPath, scenario);
  return {
    capturePath,
    manifest: {
      capturePath,
      captureSha256: digest(capture),
      client: "stock-t3-opencode-adapter" as const,
      corpusId: PINNED_CORPUS,
      generatedAt: "2026-08-31T12:00:00.000Z",
      openCodeCommit: "9f69463f1d556af2b5b51d2efa1c04f5f544f911",
      opencodeArgv: ["opencode", "serve"],
      provenance: provenance(),
      runId: "run",
      scenarioOutput: scenarioPath,
      scenarioSha256: digest(scenario),
      status: "passed" as const,
      t3Argv: ["pnpm", "test"],
      t3Commit: "9b2d04317c68233782e0630464ac86d77d0686f3",
    },
  };
}

function frozenRow(
  evidence: JsonValue[],
  support: "required" | "conditional" | "excluded" = "required",
  scenario = "C01"
): Matrix {
  return {
    corpusId: PINNED_CORPUS,
    rows: [
      {
        confidence: "observed",
        errorBehavior: "none",
        evidence,
        events: [],
        id: "OC-T3-0001",
        normalization: [],
        operation: "global.health",
        request: {
          headers: { accept: "application/json" },
          method: "GET",
          path: "/global/health",
          query: {},
          body: { title: "hello" },
        },
        response: {
          body: { ok: true },
          headers: { "content-type": "application/json" },
          status: 200,
        },
        stateEffect: {},
        scenario,
        support,
        trigger: "startup",
      },
    ],
    schemaVersion: 1,
    status: "frozen",
  };
}

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

  test("binds a frozen matrix to the verified reference corpus", () => {
    const matrix = {
      corpusId: "corpus-a",
      rows: [],
      schemaVersion: 1,
      status: "frozen",
    } as Matrix;
    expect(() => assertMatrixCorpus(matrix, "corpus-b")).toThrow(
      "does not match reference corpus"
    );
    expect(() => assertMatrixCorpus(matrix, "corpus-a")).not.toThrow();
  });

  test("binds required rows to raw capture and T3 source evidence", async () => {
    const { manifest } = await verifiedFixture();
    await expect(
      validateMatrixEvidence(
        frozenRow(["raw:C01#1", "t3:OC-HTTP-0001#verifyOpenCodeServerVersion"]),
        manifest
      )
    ).resolves.toBeUndefined();
  });

  test("rejects arbitrary evidence strings in frozen required rows", async () => {
    const { manifest } = await verifiedFixture();
    await expect(
      validateMatrixEvidence(frozenRow(["capture", "source"]), manifest)
    ).rejects.toThrow("invalid evidence");
  });

  test("rejects raw evidence from another scenario", async () => {
    const { manifest } = await verifiedFixture();
    await expect(
      validateMatrixEvidence(
        frozenRow(["raw:C02#2", "t3:OC-HTTP-0001#verifyOpenCodeServerVersion"]),
        manifest
      )
    ).rejects.toThrow("does not reference C01");
  });

  test("rejects frozen rows without normalized expected behavior", async () => {
    const { manifest } = await verifiedFixture();
    const row = frozenRow([
      "raw:C01#1",
      "t3:OC-HTTP-0001#verifyOpenCodeServerVersion",
    ]);
    (row.rows[0] as Record<string, JsonValue>).response = {};
    await expect(validateMatrixEvidence(row, manifest)).rejects.toThrow(
      "normalized request and response behavior"
    );
  });

  test("rejects normalized response status that differs from capture", async () => {
    const { manifest } = await verifiedFixture();
    const row = frozenRow([
      "raw:C01#1",
      "t3:OC-HTTP-0001#verifyOpenCodeServerVersion",
    ]);
    (row.rows[0] as Record<string, JsonValue>).response = { status: 201 };
    await expect(validateMatrixEvidence(row, manifest)).rejects.toThrow(
      "response status does not match"
    );
  });

  test("rejects T3 evidence that is not an inventory source", async () => {
    const { manifest } = await verifiedFixture();
    await expect(
      validateMatrixEvidence(
        frozenRow(["raw:C01#1", "t3:invented-consumer"]),
        manifest
      )
    ).rejects.toThrow("does not resolve to a pinned inventory source");
  });

  test("binds every represented wire field to raw evidence", async () => {
    const { manifest } = await verifiedFixture();
    const row = frozenRow([
      "raw:C01#1",
      "t3:OC-HTTP-0001#verifyOpenCodeServerVersion",
    ]);
    const value = row.rows[0] as Record<string, JsonValue>;
    value.request = {
      headers: { accept: "text/plain" },
      method: "GET",
      path: "/global/health",
      query: {},
    };
    await expect(validateMatrixEvidence(row, manifest)).rejects.toThrow(
      "request headers do not match"
    );
  });

  test("rejects operation identity that disagrees with the inventory", async () => {
    const { manifest } = await verifiedFixture();
    const row = frozenRow(["raw:C01#1", "t3:OC-HTTP-0002#loadProviders"]);
    (row.rows[0] as Record<string, JsonValue>).operation = "provider.list";
    await expect(validateMatrixEvidence(row, manifest)).rejects.toThrow(
      "does not match inventory operation"
    );
  });

  test("rejects represented request bodies that differ from capture", async () => {
    const { manifest } = await verifiedFixture();
    const row = frozenRow([
      "raw:C01#1",
      "t3:OC-HTTP-0001#verifyOpenCodeServerVersion",
    ]);
    const request = (row.rows[0] as Record<string, JsonValue>)
      .request as Record<string, JsonValue>;
    request.body = { title: "different" };
    await expect(validateMatrixEvidence(row, manifest)).rejects.toThrow(
      "request body does not match"
    );
  });

  test("validates conditional rows when their scenario is applicable", async () => {
    const { manifest } = await verifiedFixture();
    await expect(
      validateMatrixEvidence(
        frozenRow(
          ["raw:C02#2", "t3:OC-HTTP-0001#verifyOpenCodeServerVersion"],
          "conditional",
          "C02"
        ),
        manifest
      )
    ).resolves.toBeUndefined();
  });

  test("skips conditional rows only for explicitly not-applicable scenarios", async () => {
    const { manifest } = await verifiedFixture("C02");
    await expect(
      validateMatrixEvidence(
        frozenRow(["forged evidence"], "conditional", "C02"),
        manifest
      )
    ).resolves.toBeUndefined();
  });

  test("rejects required rows for not-applicable scenarios", async () => {
    const { manifest } = await verifiedFixture("C02");
    await expect(
      validateMatrixEvidence(
        frozenRow(
          ["raw:C02#2", "t3:OC-HTTP-0001#verifyOpenCodeServerVersion"],
          "required",
          "C02"
        ),
        manifest
      )
    ).rejects.toThrow("requires non-applicable reference scenario");
  });
});
