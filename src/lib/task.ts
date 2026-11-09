// "Tasks": short-lived scripts that make RAM-expensive API calls and hand the
// result back as JSON through a file. A script's RAM cost is the sum of every NS
// function it references, so keeping Singularity/Gang/etc. calls out of the
// long-running daemon keeps it tiny; each task only pays for itself, briefly.
//
// Caller side:  const r = await runTask<Snapshot>(ns, "tasks/snapshot.js", [arg1])
// Task side:    export async function main(ns) { await task(ns, async (args) => ...) }
import type { NS, ScriptArg } from "@ns";
import { TASK_DIR } from "./paths.js";

interface Envelope<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

export interface TaskResult<T> {
  ok: boolean;
  value?: T;
  /** "ram" = could not start (not enough free RAM on home), "error" = threw, "timeout" */
  reason?: "ram" | "error" | "timeout" | "missing";
  error?: string;
}

/** Run a task script on home and wait for its JSON result. */
export async function runTask<T>(
  ns: NS,
  script: string,
  args: ScriptArg[] = [],
  timeoutMs = 120_000,
): Promise<TaskResult<T>> {
  if (!ns.fileExists(script, "home")) return { ok: false, reason: "missing", error: script };
  const out = `${TASK_DIR}/${script.replace(/[/.]/g, "_")}.txt`;
  ns.write(out, "", "w");
  const pid = ns.exec(script, "home", { threads: 1, temporary: true }, out, ...args);
  if (pid === 0) return { ok: false, reason: "ram", error: `not enough RAM on home for ${script}` };
  const deadline = Date.now() + timeoutMs;
  while (ns.isRunning(pid)) {
    if (Date.now() > deadline) {
      ns.kill(pid);
      return { ok: false, reason: "timeout", error: script };
    }
    await ns.sleep(10);
  }
  const raw = ns.read(out);
  if (!raw) return { ok: false, reason: "error", error: `${script} produced no result` };
  try {
    const env = JSON.parse(raw) as Envelope<T>;
    return env.ok ? { ok: true, value: env.value } : { ok: false, reason: "error", error: env.error };
  } catch (e) {
    return { ok: false, reason: "error", error: String(e) };
  }
}


/**
 * Start a task without waiting for it (for long-running work like backdoors, or
 * tasks that never return like install). Returns the pid, or 0 if it couldn't start.
 * Skips if the same task script is already running.
 */
export function spawnTask(ns: NS, script: string, args: ScriptArg[] = []): number {
  if (!ns.fileExists(script, "home")) return 0;
  for (const p of ns.ps("home")) if (p.filename === script) return 0;
  const out = `${TASK_DIR}/${script.replace(/[/.]/g, "_")}.txt`;
  return ns.exec(script, "home", { threads: 1, temporary: true }, out, ...args);
}
