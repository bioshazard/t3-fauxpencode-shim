import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("creates pairing tokens from managed state or an explicit public URL", async () => {
  const root = mkdtempSync(join(tmpdir(), "t3-connection-"));
  const binaryDirectory = join(root, "bin");
  const workerHome = join(root, "worker");
  const frpcConfig = join(workerHome, "frp", "frpc.toml");
  mkdirSync(binaryDirectory);
  mkdirSync(join(workerHome, "frp"), { recursive: true });
  writeFileSync(
    frpcConfig,
    '[[proxies]]\nname = "t3"\ntype = "http"\ncustomDomains = ["t3.example.test"]\n'
  );
  const bunx = join(binaryDirectory, "bunx");
  writeFileSync(bunx, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');
  chmodSync(bunx, 0o755);
  writeFileSync(
    join(root, ".env"),
    "T3_HOME=/wrong/env/home\nPI_FRPC_CONFIG=/wrong/env/frpc.toml\n"
  );

  try {
    const environment = { ...process.env };
    delete environment.PI_FRPC_CONFIG;
    delete environment.T3_HOME;
    delete environment.T3_PUBLIC_URL;
    delete environment.T3_VERSION;
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "..", "bin", "t3-fauxpencode.mjs"),
        "connection",
      ],
      cwd: root,
      env: {
        ...environment,
        PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
        T3_WORKER_HOME: workerHome,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Public URL: https://t3.example.test\n");
    expect(stdout).toContain(`--base-dir\n${join(workerHome, "t3")}\n`);
    expect(stdout).not.toContain("artifacts/t3-shim-home");

    rmSync(frpcConfig);
    const direct = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "..", "bin", "t3-fauxpencode.mjs"),
        "connection",
      ],
      cwd: root,
      env: {
        ...environment,
        PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
        T3_PUBLIC_URL: "https://workspace.example.test",
        T3_WORKER_HOME: workerHome,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [directExitCode, directStdout, directStderr] = await Promise.all([
      direct.exited,
      new Response(direct.stdout).text(),
      new Response(direct.stderr).text(),
    ]);

    expect(directStderr).toBe("");
    expect(directExitCode).toBe(0);
    expect(directStdout).toContain(
      "Public URL: https://workspace.example.test\n"
    );
    expect(directStdout).toContain(`--base-dir\n${join(workerHome, "t3")}\n`);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
