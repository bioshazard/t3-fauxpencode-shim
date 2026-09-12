import { readFileSync } from "node:fs";

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function processStartToken(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
      return fields[19];
    } catch {
      return undefined;
    }
  }
  if (process.platform === "darwin") {
    const result = Bun.spawnSync({
      cmd: ["ps", "-o", "lstart=", "-p", String(pid)],
      stderr: "ignore",
      stdout: "pipe",
    });
    if (result.exitCode !== 0) return undefined;
    const value = result.stdout.toString().trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}
