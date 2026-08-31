import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { loadCapture } from "./capture.ts";
import {
  decodeReferenceManifest,
  validateCompletedScenarioReport,
  type ReferenceManifest,
} from "./reference-artifacts.ts";

async function sha256File(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer();
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await Bun.file(path).text()) as unknown;
  } catch {
    throw new Error(`Reference artifact ${path} is missing or invalid JSON.`);
  }
}

function artifactPath(path: string): string {
  return resolve(path);
}

export async function verifyReferenceArtifacts(
  manifestPath: string
): Promise<ReferenceManifest> {
  const manifest = decodeReferenceManifest(await readJson(manifestPath));
  if (manifest.status !== "passed")
    throw new Error("Reference manifest is not a passed corpus.");
  if (
    manifest.captureSha256 === undefined ||
    manifest.scenarioSha256 === undefined
  )
    throw new Error("Reference manifest is missing artifact checksums.");

  const capturePath = artifactPath(manifest.capturePath);
  const scenarioPath = artifactPath(
    manifest.scenarioOutput ?? `artifacts/runs/${manifest.corpusId}.json`
  );
  if (!(await Bun.file(capturePath).exists()))
    throw new Error(`Reference capture ${capturePath} does not exist.`);
  if (!(await Bun.file(scenarioPath).exists()))
    throw new Error(
      `Reference scenario report ${scenarioPath} does not exist.`
    );

  const captureSha256 = await sha256File(capturePath);
  if (captureSha256 !== manifest.captureSha256)
    throw new Error(`Reference capture checksum mismatch for ${capturePath}.`);
  const scenarioSha256 = await sha256File(scenarioPath);
  if (scenarioSha256 !== manifest.scenarioSha256)
    throw new Error(
      `Reference scenario checksum mismatch for ${scenarioPath}.`
    );

  const records = await loadCapture(capturePath);
  if (records.length === 0)
    throw new Error("Reference capture contains no records.");
  for (const record of records) {
    if (record.correlation?.["x-contract-run-id"] !== manifest.runId)
      throw new Error("Reference capture contains a record from another run.");
    if (record.correlation?.["x-contract-scenario"] === "unknown")
      throw new Error("Reference capture contains an unclassified exchange.");
  }

  validateCompletedScenarioReport(await readJson(scenarioPath), {
    corpusId: manifest.corpusId,
    runId: manifest.runId,
  });
  return manifest;
}

if (import.meta.main) {
  const manifestPath = Bun.argv[2] ?? Bun.env.REFERENCE_MANIFEST;
  if (manifestPath === undefined || manifestPath.trim().length === 0)
    throw new Error("Reference manifest input is required.");
  const manifest = await verifyReferenceArtifacts(manifestPath);
  console.log(
    `verified reference corpus ${manifest.corpusId}; capture ${manifest.captureSha256}; scenarios ${manifest.scenarioSha256}`
  );
}
