import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import type { WorkerProcessId, WorkerProcessSpec } from "./worker.ts";

export type WorkerRuntimeState = {
  readonly children: Partial<
    Record<WorkerProcessId, { readonly name: string; readonly pid: number }>
  >;
  readonly mode: "foreground";
  readonly startedAt: string;
  readonly supervisorPid: number;
};

type Child = ReturnType<typeof Bun.spawn>;
type ExitOutcome = {
  readonly child: Child;
  readonly code: number;
  readonly kind: "exit";
  readonly spec: WorkerProcessSpec;
};
type SignalOutcome = {
  readonly kind: "signal";
  readonly signal: NodeJS.Signals;
};

export function readRuntimeState(path: string): WorkerRuntimeState | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as WorkerRuntimeState;
    return value.mode === "foreground" && Number.isInteger(value.supervisorPid)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function writeRuntimeState(
  path: string,
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
    mode: "foreground",
    startedAt: new Date().toISOString(),
    supervisorPid: process.pid,
  };
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function removeOwnedRuntimeState(path: string): void {
  if (readRuntimeState(path)?.supervisorPid === process.pid) {
    rmSync(path, { force: true });
  }
}

async function stopChildren(
  children: readonly Child[],
  signal: NodeJS.Signals
): Promise<void> {
  for (const child of children) {
    if (child.exitCode === null) child.kill(signal);
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(children.map((child) => child.exited)),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, 10_000);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);

  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await Promise.allSettled(children.map((child) => child.exited));
}

export async function runForeground(
  specs: readonly WorkerProcessSpec[],
  runtimePath: string
): Promise<number> {
  if (specs.length === 0) throw new Error("Worker process graph is empty.");

  const children: Child[] = [];
  let resolveSignal: (outcome: SignalOutcome) => void = () => undefined;
  const signaled = new Promise<SignalOutcome>((resolve) => {
    resolveSignal = resolve;
  });
  const onSigint = () => resolveSignal({ kind: "signal", signal: "SIGINT" });
  const onSigterm = () => resolveSignal({ kind: "signal", signal: "SIGTERM" });
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    for (const spec of specs) {
      children.push(
        Bun.spawn({
          cmd: [...spec.command],
          cwd: spec.cwd,
          env: { ...Bun.env, ...spec.env },
          stdin: "inherit",
          stderr: "inherit",
          stdout: "inherit",
        })
      );
    }
    writeRuntimeState(runtimePath, specs, children);
    const exited = children.map((child, index) =>
      child.exited.then((code): ExitOutcome => ({
        child,
        code,
        kind: "exit",
        spec: specs[index]!,
      }))
    );
    const outcome = await Promise.race([signaled, ...exited]);
    await stopChildren(
      children,
      outcome.kind === "signal" ? outcome.signal : "SIGTERM"
    );
    if (outcome.kind === "signal") return 0;
    if (outcome.code === 0) {
      console.error(`${outcome.spec.name} stopped unexpectedly.`);
      return 1;
    }
    console.error(`${outcome.spec.name} exited with code ${outcome.code}.`);
    return outcome.code;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await stopChildren(children, "SIGTERM");
    removeOwnedRuntimeState(runtimePath);
  }
}
