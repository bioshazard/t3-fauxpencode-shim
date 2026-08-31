import { defineConfig } from "@playwright/test";

const shimPort = Number.parseInt(process.env.PW_SHIM_PORT ?? "41874", 10);
const shimBaseURL =
  process.env.PW_SHIM_BASE_URL?.trim() || `http://127.0.0.1:${shimPort}`;
const t3BaseURL =
  process.env.T3_WEB_BASE_URL?.trim() || "http://127.0.0.1:5976";
const t3StorageState = process.env.T3_STORAGE_STATE?.trim() || undefined;
const hasExternalShim = Boolean(process.env.PW_SHIM_BASE_URL?.trim());

export default defineConfig({
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  outputDir: "artifacts/playwright",
  reporter: process.env.CI ? "line" : "list",
  retries: process.env.CI ? 2 : 0,
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: shimBaseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "shim",
      testMatch: "**/shim-protocol.spec.ts",
    },
    {
      name: "t3",
      testMatch: "**/t3-live.spec.ts",
      use: {
        baseURL: t3BaseURL,
        ...(t3StorageState === undefined
          ? {}
          : { storageState: t3StorageState }),
        // Pairing URLs contain a one-time credential. Do not persist them in
        // traces or video artifacts if the opt-in test fails.
        trace: "off",
        video: "off",
      },
    },
  ],
  webServer: !hasExternalShim
    ? {
        command: `PI_OPENCODE_HOST=127.0.0.1 PI_OPENCODE_PORT=${shimPort} PI_SESSION_DIR=artifacts/playwright-sessions bun run start`,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
        url: `${shimBaseURL}/global/health`,
      }
    : undefined,
});
