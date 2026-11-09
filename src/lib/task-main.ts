// Task side of lib/task.ts, split out so tasks don't import the daemon-side launcher
// (runTask/spawnTask reference exec/kill/ps, ~2 GB every task would pay for). Pure I/O.
import type { NS, ScriptArg } from "@ns";
import { replacer } from "./io.js";

interface Envelope<T> {
  ok: boolean;
  value?: T;
  error?: string;
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
