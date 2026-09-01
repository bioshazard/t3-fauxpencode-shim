import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_SHIM_URL = "http://127.0.0.1:41874";

function shimUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PI_OPENCODE_URL must be an HTTP(S) URL.");
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(
      "PI_OPENCODE_URL must not contain credentials or a fragment."
    );
  }
  return url.toString().replace(/\/$/u, "");
}

export function writeT3ShimSettings(home: string, serverUrl: string): string {
  const settingsPath = resolve(home, "userdata", "settings.json");
  mkdirSync(resolve(home, "userdata"), { recursive: true });
  writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        providers: {
          claudeAgent: { enabled: false },
          codex: { enabled: false },
          opencode: { enabled: true, serverUrl: shimUrl(serverUrl) },
        },
        textGenerationModelSelection: {
          instanceId: "opencode",
          model: "pi/configured",
          options: [],
        },
      },
      null,
      2
    )}\n`
  );
  return settingsPath;
}

if (import.meta.main) {
  const home = Bun.env.T3_HOME?.trim();
  if (home === undefined || home.length === 0) {
    throw new Error("T3_HOME is required.");
  }
  const settingsPath = writeT3ShimSettings(
    home,
    Bun.env.PI_OPENCODE_URL ?? DEFAULT_SHIM_URL
  );
  console.log(`Wrote ${settingsPath}`);
}
