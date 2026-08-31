import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REQUIRED_REFERENCE_SCENARIOS } from "../tools/contract/reference-artifacts.ts";
import { verifyReferenceArtifacts } from "../tools/contract/reference-verify.ts";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function captureRecord(): Record<string, unknown> {
  return {
    body: {
      request: null,
      requestTruncated: false,
      response: "{}",
      responseTruncated: false,
    },
    connection: {
      closedAt: "2026-08-31T12:00:00.000Z",
      reason: "normal",
      state: "closed",
    },
    correlation: {
      "x-contract-run-id": "run",
      "x-contract-scenario": "C01",
    },
    durationMs: 1,
    request: { headers: {}, method: "GET", path: "/global/health", query: {} },
    response: { headers: {}, status: 200 },
    sequence: 1,
    startedAt: "2026-08-31T12:00:00.000Z",
  };
}

describe("reference corpus verification", () => {
  test("verifies a passed manifest and detects tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "reference-verify-"));
    const capturePath = join(root, "capture.jsonl");
    const scenarioPath = join(root, "scenarios.json");
    const manifestPath = join(root, "manifest.json");
    const capture = `${JSON.stringify(captureRecord())}\n`;
    const scenario = JSON.stringify({
      corpusId: "corpus",
      generatedAt: "2026-08-31T12:00:00.000Z",
      runId: "run",
      scenarios: REQUIRED_REFERENCE_SCENARIOS.map((id) => ({
        id,
        passed: true,
      })),
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
        corpusId: "corpus",
        generatedAt: "2026-08-31T12:00:00.000Z",
        openCodeCommit: "b".repeat(40),
        opencodeArgv: ["opencode", "serve"],
        runId: "run",
        scenarioOutput: scenarioPath,
        scenarioSha256: digest(scenario),
        status: "passed",
        t3Argv: ["pnpm", "test"],
        t3Commit: "d".repeat(40),
      })
    );

    expect((await verifyReferenceArtifacts(manifestPath)).corpusId).toBe(
      "corpus"
    );
    await Bun.write(scenarioPath, `${scenario} `);
    await expect(verifyReferenceArtifacts(manifestPath)).rejects.toThrow(
      "scenario checksum mismatch"
    );
  });
});
