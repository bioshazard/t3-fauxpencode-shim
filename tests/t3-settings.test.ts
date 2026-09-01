import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeT3ShimSettings } from "../tools/write-t3-shim-settings.ts";

test("writes an isolated T3 shim-only provider configuration", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-opencode-t3-test-"));
  try {
    const path = writeT3ShimSettings(home, "http://127.0.0.1:41874/");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      providers: {
        claudeAgent: { enabled: false },
        codex: { enabled: false },
        opencode: { enabled: true, serverUrl: "http://127.0.0.1:41874" },
      },
      textGenerationModelSelection: {
        instanceId: "opencode",
        model: "configured",
        options: [],
      },
    });
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});
