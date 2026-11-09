// RAM-minimal proxy for single Netscript functions.
//
//   const prices = await callEach<number>(ns, "singularity.getAugmentationPrice", augs.map((a) => [a]));
//
// Generates (once) a tiny script tmp/call/<fn>.js that applies ONE function to a
// list of argument tuples and writes the results to a file. Since the game prices
// a script by the functions it references, that script costs 1.6 GB + that one
// function — far less than a task that references many. The function name only
// appears inside a string here, so callers aren't charged for it either.
import type { NS } from "@ns";

const DIR = "tmp/call";

function source(fn: string): string {
  // NB: keep the generated code tiny; the function reference below is what the RAM
  // calculator charges for.
  return `export async function main(ns) {
  const [out, input] = ns.args;
  const lists = JSON.parse(ns.read(input));
  const res = [];
  for (const a of lists) {
    try { res.push({ v: await ns.${fn}(...a) }); } catch (e) { res.push({ e: String(e) }); }
  }
  ns.write(out, JSON.stringify(res, (k, v) => (v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : v)), "w");
}
`;
}

export class CallError extends Error {}

/**
 * Apply `fn` (a dotted path under ns, e.g. "singularity.getFactionRep") to every
 * argument tuple. Returns one result per tuple (undefined where that call threw).
 * Throws CallError if the proxy can't run (e.g. not enough free RAM on home).
 */
export async function callEach<R>(ns: NS, fn: string, argLists: unknown[][], timeoutMs = 60_000): Promise<(R | undefined)[]> {
  if (!/^[A-Za-z0-9_.]+$/.test(fn)) throw new CallError(`bad function path ${fn}`);
  if (argLists.length === 0) return [];
  const script = `${DIR}/${fn}.js`;
  const src = source(fn);
  if (ns.read(script) !== src) ns.write(script, src, "w");
  // per caller script: two scripts calling the same function at once must not share files
  const who = ns.getScriptName().replace(/[^A-Za-z0-9]/g, "_");
  const input = `${DIR}/${fn}.${who}.in.txt`;
  const out = `${DIR}/${fn}.${who}.out.txt`;
  ns.write(input, JSON.stringify(argLists), "w");
  ns.write(out, "", "w");
  // RAM on home comes and goes (batch bursts, other proxies): retry for ~1 s before giving up
  let pid = 0;
  for (let attempt = 0; attempt < 6 && pid === 0; attempt++) {
    if (attempt) await ns.sleep(200);
    pid = ns.exec(script, "home", { threads: 1, temporary: true }, out, input);
  }
  if (pid === 0) throw new CallError(`could not start ${fn} (not enough free RAM on home?)`);
  const deadline = Date.now() + timeoutMs;
  while (ns.isRunning(pid)) {
    if (Date.now() > deadline) {
      ns.kill(pid);
      throw new CallError(`${fn} timed out`);
    }
    await ns.sleep(5);
  }
  const raw = ns.read(out);
  if (!raw) throw new CallError(`${fn} produced no output`);
  return (JSON.parse(raw) as { v?: R; e?: string }[]).map((r) => r.v);
}

/** Single call convenience wrapper. */
export async function call<R>(ns: NS, fn: string, ...args: unknown[]): Promise<R | undefined> {
  return (await callEach<R>(ns, fn, [args]))[0];
}
