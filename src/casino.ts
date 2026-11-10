// Launcher for the blackjack save-scummer (casino/table.js).
//
//   run casino.js
//
// The table script needs ~36 GB (25 GB of that is the game's charge for touching the
// page), and the hacking manager keeps home nearly full. This launcher is small enough to
// always start: it frees RAM by killing hack *workers on home only* (the manager just
// re-preps those targets), then starts the table script.
import type { NS } from "@ns";
import { SCRIPTS } from "./lib/paths.js";
import { appendLine } from "./lib/io.js";

const WORKERS: string[] = [SCRIPTS.hackScript, SCRIPTS.growScript, SCRIPTS.weakenScript, SCRIPTS.shareScript];

/** Breadcrumbs pulled out of the game by the sync tool (logs/casino-trace.txt). */
const TRACE = "data/casino-trace.txt";
const trace = (ns: NS, msg: string) => appendLine(ns, TRACE, `${new Date().toISOString()} launcher ${msg}`);

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  trace(ns, `started on ${ns.getHostname()}`);
  if (ns.isRunning(SCRIPTS.casinoTable, "home")) {
    ns.tprint(`casino: ${SCRIPTS.casinoTable} is already running (kill it with: kill ${SCRIPTS.casinoTable})`);
    return;
  }
  const need = ns.getScriptRam(SCRIPTS.casinoTable, "home");
  if (need <= 0) {
    ns.tprint(`casino: ${SCRIPTS.casinoTable} is missing`);
    return;
  }
  const free = () => ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
  if (free() < need) {
    // biggest worker processes first → fewest kills
    const workers = ns
      .ps("home")
      .filter((p) => WORKERS.includes(p.filename))
      .sort((a, b) => b.threads - a.threads);
    let killed = 0;
    for (const p of workers) {
      if (free() >= need) break;
      if (ns.kill(p.pid)) killed++;
    }
    if (killed) ns.tprint(`casino: stopped ${killed} hack worker(s) on home to free RAM`);
  }
  if (free() < need) {
    ns.tprint(`casino: need ${ns.format.ram(need)} free on home, only ${ns.format.ram(free())} available`);
    return;
  }
  const pid = ns.exec(SCRIPTS.casinoTable, "home");
  trace(ns, `exec ${SCRIPTS.casinoTable} → pid ${pid} (need ${need} GB, free ${free()} GB)`);
  if (pid) ns.tprint(`casino: started ${SCRIPTS.casinoTable} (pid ${pid}, ${ns.format.ram(need)}; ${ns.format.ram(free())} still free)`);
  else ns.tprint(`casino: failed to start ${SCRIPTS.casinoTable} (needs ${ns.format.ram(need)}, ${ns.format.ram(free())} free)`);
}
