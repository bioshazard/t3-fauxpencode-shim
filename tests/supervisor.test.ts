import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { WorkerProcessSpec } from "../src/worker.ts";

type PipedChild = Bun.Subprocess<"ignore", "pipe", "pipe">;

function spawnHarness(harness: string): PipedChild {
  return Bun.spawn({
    cmd: [process.execPath, harness],
    stderr: "pipe",
    stdout: "pipe",
  });
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

async function fixture(behavior: "fail" | "slow" | "wait") {
  const root = await mkdtemp(join(tmpdir(), "worker-supervisor-"));
  const childScript = join(root, "child.ts");
  const harness = join(root, "harness.ts");
  const runtime = join(root, "runtime.json");
  const runtimeLock = `${runtime}.lock`;
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
let signalCount = 0;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  signalCount += 1;
  if (behavior.includes("slow") && signalCount === 1) {
    writeFileSync(stopped + ".first", signal);
    return;
  }
  writeFileSync(stopped, signal);
  process.exit(0);
});
if (behavior.startsWith("tree")) {
  Bun.spawn({
    cmd: [process.execPath, import.meta.path, "t3-descendant", behavior.includes("slow") ? "slow" : "wait", descendantStarted, descendantStopped],
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
        behavior === "slow" ? "tree-slow" : "tree",
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
    runtimeLock,
    started,
    stopped,
  };
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`foreground mode streams logs and forwards ${signal} to every process`, async () => {
    const item = await fixture("wait");
    try {
      const worker = spawnHarness(item.harness);
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
      expect(existsSync(item.runtimeLock)).toBe(false);
    } finally {
      await rm(item.root, { force: true, recursive: true });
    }
  });
}

test("foreground mode stops peers and exits nonzero when a child fails", async () => {
  const item = await fixture("fail");
  try {
    const worker = spawnHarness(item.harness);
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
    expect(existsSync(item.runtimeLock)).toBe(false);
  } finally {
    await rm(item.root, { force: true, recursive: true });
  }
});

test("foreground mode keeps forwarding signals during graceful shutdown", async () => {
  const item = await fixture("slow");
  let worker: ReturnType<typeof Bun.spawn> | undefined;
  try {
    worker = spawnHarness(item.harness);
    await Promise.all([
      waitFor(item.started("shim")),
      waitFor(item.started("t3")),
      waitFor(item.descendantStarted),
      waitFor(item.runtime),
    ]);
    worker.kill("SIGTERM");
    await Promise.all([
      waitFor(`${item.stopped("shim")}.first`),
      waitFor(`${item.stopped("t3")}.first`),
      waitFor(`${item.descendantStopped}.first`),
    ]);
    worker.kill("SIGTERM");

    expect(await worker.exited).toBe(0);
    expect(await readFile(item.stopped("shim"), "utf8")).toBe("SIGTERM");
    expect(await readFile(item.stopped("t3"), "utf8")).toBe("SIGTERM");
    expect(await readFile(item.descendantStopped, "utf8")).toBe("SIGTERM");
  } finally {
    worker?.kill("SIGKILL");
    await worker?.exited;
    await rm(item.root, { force: true, recursive: true });
  }
});

test("foreground mode atomically admits one simultaneous owner", async () => {
  const item = await fixture("wait");
  const contenders: PipedChild[] = [];
  try {
    for (let index = 0; index < 6; index += 1) {
      contenders.push(spawnHarness(item.harness));
    }
    await waitFor(item.runtime);
    await Bun.sleep(200);
    const owners = contenders.filter((child) => child.exitCode === null);
    const rejected = contenders.filter((child) => child.exitCode !== null);

    expect(owners).toHaveLength(1);
    expect(rejected).toHaveLength(5);
    expect(rejected.every((child) => child.exitCode === 1)).toBe(true);
    const errors = await Promise.all(
      rejected.map((child) => new Response(child.stderr).text())
    );
    expect(errors.every((error) => error.includes("already running"))).toBe(
      true
    );
  } finally {
    for (const contender of contenders) contender.kill("SIGTERM");
    await Promise.allSettled(contenders.map((contender) => contender.exited));
    await rm(item.root, { force: true, recursive: true });
  }
});

test("foreground mode replaces stale ownership state", async () => {
  const item = await fixture("wait");
  let worker: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await writeFile(
      item.runtime,
      JSON.stringify({
        children: {},
        instanceId: "stale",
        mode: "foreground",
        processStartToken: "stale-process",
        startedAt: "2026-01-01T00:00:00.000Z",
        supervisorPid: 99_999_999,
      })
    );
    await mkdir(item.runtimeLock);
    await utimes(item.runtimeLock, new Date(0), new Date(0));
    worker = spawnHarness(item.harness);
    await waitFor(item.started("shim"));
    worker.kill("SIGTERM");
    expect(await worker.exited).toBe(0);
    expect(existsSync(item.runtime)).toBe(false);
    expect(existsSync(item.runtimeLock)).toBe(false);
  } finally {
    worker?.kill("SIGTERM");
    await worker?.exited;
    await rm(item.root, { force: true, recursive: true });
  }
});
