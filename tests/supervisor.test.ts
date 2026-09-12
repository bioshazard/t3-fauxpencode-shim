import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { WorkerProcessSpec } from "../src/worker.ts";

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

async function fixture(behavior: "fail" | "wait") {
  const root = await mkdtemp(join(tmpdir(), "worker-supervisor-"));
  const childScript = join(root, "child.ts");
  const harness = join(root, "harness.ts");
  const runtime = join(root, "runtime.json");
  const started = (id: string) => join(root, `${id}.started`);
  const stopped = (id: string) => join(root, `${id}.stopped`);
  const descendantStarted = started("t3-descendant");
  const descendantStopped = stopped("t3-descendant");
  await writeFile(
    childScript,
    `import { writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
const [id, behavior, started, stopped, descendantStarted, descendantStopped] = Bun.argv.slice(2);
writeFileSync(started, "started");
console.log("child-log:" + id);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  writeFileSync(stopped, signal);
  process.exit(0);
});
if (behavior === "tree") {
  Bun.spawn({
    cmd: [process.execPath, import.meta.path, "t3-descendant", "wait", descendantStarted, descendantStopped],
    stdin: "ignore",
    stderr: "inherit",
    stdout: "inherit",
  });
}
if (behavior === "fail") {
  const ready = setInterval(() => {
    if (existsSync(descendantStarted)) {
      clearInterval(ready);
      process.exit(7);
    }
  }, 5);
} else setInterval(() => undefined, 1_000);
`
  );
  const specs: WorkerProcessSpec[] = [
    {
      command: [
        process.execPath,
        childScript,
        "shim",
        behavior,
        started("shim"),
        stopped("shim"),
        descendantStarted,
        descendantStopped,
      ],
      cwd: root,
      env: {},
      id: "shim",
      name: "fixture-shim",
    },
    {
      command: [
        process.execPath,
        childScript,
        "t3",
        "tree",
        started("t3"),
        stopped("t3"),
        descendantStarted,
        descendantStopped,
      ],
      cwd: root,
      env: {},
      id: "t3",
      name: "fixture-t3",
    },
  ];
  await writeFile(
    harness,
    `import { runForeground } from ${JSON.stringify(
      pathToFileURL(join(import.meta.dir, "..", "src", "supervisor.ts")).href
    )};
const code = await runForeground(${JSON.stringify(specs)}, ${JSON.stringify(runtime)});
process.exitCode = code;
`
  );
  return {
    descendantStarted,
    descendantStopped,
    harness,
    root,
    runtime,
    started,
    stopped,
  };
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`foreground mode streams logs and forwards ${signal} to every process`, async () => {
    const item = await fixture("wait");
    try {
      const worker = Bun.spawn({
        cmd: [process.execPath, item.harness],
        stderr: "pipe",
        stdout: "pipe",
      });
      await Promise.all([
        waitFor(item.started("shim")),
        waitFor(item.started("t3")),
        waitFor(item.descendantStarted),
        waitFor(item.runtime),
      ]);
      worker.kill(signal);
      const [exitCode, stdout, stderr] = await Promise.all([
        worker.exited,
        new Response(worker.stdout).text(),
        new Response(worker.stderr).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("child-log:shim");
      expect(stdout).toContain("child-log:t3");
      expect(stdout).toContain("child-log:t3-descendant");
      expect(stderr).toBe("");
      expect(await readFile(item.stopped("shim"), "utf8")).toBe(signal);
      expect(await readFile(item.stopped("t3"), "utf8")).toBe(signal);
      expect(await readFile(item.descendantStopped, "utf8")).toBe(signal);
      expect(existsSync(item.runtime)).toBe(false);
    } finally {
      await rm(item.root, { force: true, recursive: true });
    }
  });
}

test("foreground mode stops peers and exits nonzero when a child fails", async () => {
  const item = await fixture("fail");
  try {
    const worker = Bun.spawn({
      cmd: [process.execPath, item.harness],
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      worker.exited,
      new Response(worker.stdout).text(),
    ]);

    expect(exitCode).toBe(7);
    expect(stdout).toContain("child-log:shim");
    expect(stdout).toContain("child-log:t3");
    expect(await readFile(item.stopped("t3"), "utf8")).toBe("SIGTERM");
    expect(await readFile(item.descendantStopped, "utf8")).toBe("SIGTERM");
    expect(existsSync(item.runtime)).toBe(false);
  } finally {
    await rm(item.root, { force: true, recursive: true });
  }
});
