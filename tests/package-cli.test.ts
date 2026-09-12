import { expect, test } from "bun:test";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

async function output(child: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

test("packed CLI runs outside its source checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-package-"));
  try {
    const packageRoot = resolve(import.meta.dir, "..");
    const packed = await output(
      Bun.spawn({
        cmd: ["npm", "pack", "--ignore-scripts", "--pack-destination", root],
        cwd: packageRoot,
        stderr: "pipe",
        stdout: "pipe",
      })
    );
    expect(packed.exitCode).toBe(0);
    const archive = join(root, packed.stdout.trim().split("\n").at(-1)!);
    const unpacked = await output(
      Bun.spawn({
        cmd: ["tar", "-xzf", archive, "-C", root],
        stderr: "pipe",
        stdout: "pipe",
      })
    );
    expect(unpacked).toEqual({ exitCode: 0, stderr: "", stdout: "" });

    const installed = join(root, "package");
    const project = join(root, "project");
    const smoke = join(root, "smoke");
    const workerHome = join(root, "worker");
    await mkdir(project);
    await mkdir(smoke);
    await writeFile(
      join(installed, "src", "server.ts"),
      `import { writeFileSync } from "node:fs";
const root = process.env.PACKAGE_SMOKE_ROOT!;
writeFileSync(root + "/shim.started", "started");
console.log("packed-shim");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  writeFileSync(root + "/shim.stopped", signal);
  process.exit(0);
});
setInterval(() => undefined, 1_000);
`
    );
    await writeFile(
      join(installed, "tools", "run-t3-shim.sh"),
      `#!/usr/bin/env bash
set -eu
touch "$PACKAGE_SMOKE_ROOT/t3.started"
echo packed-t3
trap 'printf %s SIGINT > "$PACKAGE_SMOKE_ROOT/t3.stopped"; exit 0' INT
trap 'printf %s SIGTERM > "$PACKAGE_SMOKE_ROOT/t3.stopped"; exit 0' TERM
while true; do sleep 1; done
`
    );

    const bin = join(installed, "bin", "t3-fauxpencode.mjs");
    const worker = Bun.spawn({
      cmd: [process.execPath, bin, "run"],
      cwd: project,
      env: {
        ...process.env,
        PACKAGE_SMOKE_ROOT: smoke,
        T3_WORKER_HOME: workerHome,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    await Promise.all([
      waitFor(join(smoke, "shim.started")),
      waitFor(join(smoke, "t3.started")),
      waitFor(join(workerHome, "runtime.json")),
    ]);
    worker.kill("SIGTERM");
    const run = await output(worker);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("packed-shim");
    expect(run.stdout).toContain("packed-t3");
    expect(await readFile(join(smoke, "shim.stopped"), "utf8")).toBe("SIGTERM");
    expect(await readFile(join(smoke, "t3.stopped"), "utf8")).toBe("SIGTERM");

    const health = await output(
      Bun.spawn({
        cmd: [process.execPath, bin, "health", "--json"],
        cwd: project,
        env: { ...process.env, T3_WORKER_HOME: workerHome },
        stderr: "pipe",
        stdout: "pipe",
      })
    );
    expect(health.exitCode).toBe(1);
    expect(JSON.parse(health.stdout)).toMatchObject({
      healthy: false,
      mode: "unknown",
      schemaVersion: 1,
    });

    const fakeBin = join(root, "bin");
    await mkdir(fakeBin);
    const bunx = join(fakeBin, "bunx");
    await writeFile(bunx, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');
    chmodSync(bunx, 0o755);
    const connection = await output(
      Bun.spawn({
        cmd: [process.execPath, bin, "connection"],
        cwd: project,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          T3_PUBLIC_URL: "https://workspace.example.test",
          T3_WORKER_HOME: workerHome,
        },
        stderr: "pipe",
        stdout: "pipe",
      })
    );
    expect(connection.exitCode).toBe(0);
    expect(connection.stdout).toContain(
      "Public URL: https://workspace.example.test"
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
