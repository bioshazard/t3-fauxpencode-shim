import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import * as lockfile from "proper-lockfile";

import { isString } from "./decode.ts";
import { processAlive, processStartToken } from "./process.ts";
import type { WorkerProcessId, WorkerProcessSpec } from "./worker.ts";

export type WorkerRuntimeState = {
  readonly children: Partial<
    Record<WorkerProcessId, { readonly name: string; readonly pid: number }>
  >;
  readonly instanceId: string;
  readonly mode: "foreground";
  readonly processStartToken: string;
  readonly startedAt: string;
  readonly supervisorPid: number;
};
type WorkerRuntimeLease = {
  readonly compromised: Promise<LockOutcome>;
  readonly instanceId: string;
  readonly processStartToken: string;
  readonly release: () => Promise<void>;
};

type Child = ReturnType<typeof Bun.spawn>;
type ExitOutcome = {
  readonly code: number;
  readonly kind: "exit";
  readonly spec: WorkerProcessSpec;
};
type SignalOutcome = {
  readonly kind: "signal";
  readonly signal: NodeJS.Signals;
};
type LockOutcome = {
  readonly error: Error;
  readonly kind: "lock-error";
};

const RUNTIME_LOCK_STALE_MS = 30_000;

export function readRuntimeState(path: string): WorkerRuntimeState | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as WorkerRuntimeState;
    return value.mode === "foreground" &&
      isString(value.instanceId) &&
      value.instanceId.length > 0 &&
      isString(value.processStartToken) &&
      value.processStartToken.length > 0 &&
      Number.isInteger(value.supervisorPid) &&
      value.supervisorPid > 0
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export async function readActiveRuntimeState(
  runtimePath: string,
  alive: (pid: number) => boolean = processAlive,
  startToken: (pid: number) => string | undefined = processStartToken
): Promise<WorkerRuntimeState | undefined> {
  const runtime = readRuntimeState(runtimePath);
  if (
    runtime === undefined ||
    !alive(runtime.supervisorPid) ||
    startToken(runtime.supervisorPid) !== runtime.processStartToken
  ) {
    return undefined;
  }
  const locked = await lockfile.check(runtimePath, {
    realpath: false,
    stale: RUNTIME_LOCK_STALE_MS,
  });
  return locked ? runtime : undefined;
}

async function acquireRuntimeLease(
  runtimePath: string
): Promise<WorkerRuntimeLease> {
  const startToken = processStartToken(process.pid);
  if (startToken === undefined) {
    throw new Error("Cannot identify the worker supervisor process.");
  }
  let resolveCompromised: (outcome: LockOutcome) => void = () => undefined;
  const compromised = new Promise<LockOutcome>((resolve) => {
    resolveCompromised = resolve;
  });
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(runtimePath, {
      onCompromised: (error) =>
        resolveCompromised({ error, kind: "lock-error" }),
      realpath: false,
      retries: 0,
      stale: RUNTIME_LOCK_STALE_MS,
      update: 10_000,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
      const owner = readRuntimeState(runtimePath);
      throw new Error(
        owner === undefined
          ? "Worker is already running."
          : `Worker is already running with PID ${owner.supervisorPid}.`
      );
    }
    throw error;
  }
  rmSync(runtimePath, { force: true });
  return {
    compromised,
    instanceId: randomUUID(),
    processStartToken: startToken,
    release,
  };
}

function writeRuntimeState(
  path: string,
  lease: WorkerRuntimeLease,
  specs: readonly WorkerProcessSpec[],
  children: readonly Child[]
): void {
  const state: WorkerRuntimeState = {
    children: Object.fromEntries(
      specs.map((spec, index) => [
        spec.id,
        { name: spec.name, pid: children[index]!.pid },
      ])
    ),
    instanceId: lease.instanceId,
    mode: "foreground",
    processStartToken: lease.processStartToken,
    startedAt: new Date().toISOString(),
    supervisorPid: process.pid,
  };
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function removeOwnedRuntimeState(
  runtimePath: string,
  lease: WorkerRuntimeLease
): void {
  if (readRuntimeState(runtimePath)?.instanceId === lease.instanceId) {
    rmSync(runtimePath, { force: true });
  }
}

async function releaseRuntimeLease(lease: WorkerRuntimeLease): Promise<void> {
  try {
    await lease.release();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERELEASED") throw error;
  }
}

async function stopChildren(
  children: readonly Child[],
  signal: NodeJS.Signals
): Promise<void> {
  for (const child of children) {
    signalChildTree(child, signal);
  }

  const deadline = Date.now() + 10_000;
  while (children.some(childTreeAlive) && Date.now() < deadline) {
    await Bun.sleep(25);
  }

  for (const child of children) {
    if (childTreeAlive(child)) signalChildTree(child, "SIGKILL");
  }
  await Promise.allSettled(children.map((child) => child.exited));
}

function childTreeAlive(child: Child): boolean {
  if (process.platform === "win32") return child.exitCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalChildTree(child: Child, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    if (child.exitCode === null) child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ESRCH" &&
      child.exitCode === null
    ) {
      child.kill(signal);
    }
  }
}

export async function runForeground(
  specs: readonly WorkerProcessSpec[],
  runtimePath: string
): Promise<number> {
  if (specs.length === 0) throw new Error("Worker process graph is empty.");

  const lease = await acquireRuntimeLease(runtimePath);
  const children: Child[] = [];
  let shuttingDown = false;
  let resolveSignal: (outcome: SignalOutcome) => void = () => undefined;
  const signaled = new Promise<SignalOutcome>((resolve) => {
    resolveSignal = resolve;
  });
  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      for (const child of children) signalChildTree(child, signal);
      return;
    }
    resolveSignal({ kind: "signal", signal });
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    for (const spec of specs) {
      children.push(
        Bun.spawn({
          cmd: [...spec.command],
          cwd: spec.cwd,
          detached: true,
          env: { ...Bun.env, ...spec.env },
          stdin: "inherit",
          stderr: "inherit",
          stdout: "inherit",
        })
      );
    }
    writeRuntimeState(runtimePath, lease, specs, children);
    const exited = children.map((child, index) =>
      child.exited.then((code): ExitOutcome => ({
        code,
        kind: "exit",
        spec: specs[index]!,
      }))
    );
    const outcome = await Promise.race([
      signaled,
      lease.compromised,
      ...exited,
    ]);
    shuttingDown = true;
    await stopChildren(
      children,
      outcome.kind === "signal" ? outcome.signal : "SIGTERM"
    );
    if (outcome.kind === "signal") return 0;
    if (outcome.kind === "lock-error") {
      console.error(
        `Worker runtime lock was compromised: ${outcome.error.message}`
      );
      return 1;
    }
    if (outcome.code === 0) {
      console.error(`${outcome.spec.name} stopped unexpectedly.`);
      return 1;
    }
    console.error(`${outcome.spec.name} exited with code ${outcome.code}.`);
    return outcome.code;
  } finally {
    shuttingDown = true;
    try {
      await stopChildren(children, "SIGTERM");
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      removeOwnedRuntimeState(runtimePath, lease);
      await releaseRuntimeLease(lease);
    }
  }
}
