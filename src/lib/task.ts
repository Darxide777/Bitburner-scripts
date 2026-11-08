// "Tasks": short-lived scripts that make RAM-expensive API calls and hand the
// result back as JSON through a file. A script's RAM cost is the sum of every NS
// function it references, so keeping Singularity/Gang/etc. calls out of the
// long-running daemon keeps it tiny; each task only pays for itself, briefly.
//
// Caller side:  const r = await runTask<Snapshot>(ns, "tasks/snapshot.js", [arg1])
// Task side:    export async function main(ns) { await task(ns, async (args) => ...) }
import type { NS, ScriptArg } from "@ns";
import { replacer } from "./io.js";
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

/** Wrap a task's body: handles args, errors and writing the result envelope. */
export async function task<T>(ns: NS, body: (args: ScriptArg[]) => T | Promise<T>): Promise<void> {
  ns.disableLog("ALL");
  const [out, ...rest] = ns.args;
  let env: Envelope<T>;
  try {
    env = { ok: true, value: await body(rest) };
  } catch (e) {
    env = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  ns.write(String(out), JSON.stringify(env, replacer), "w");
}
