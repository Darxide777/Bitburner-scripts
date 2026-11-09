// Restarts daemon.js (and the long-running managers, so they run new code too) after
// the sync server pushes a new build. The daemon exits right after spawning this.
// args: (result file, unused)
import type { NS } from "@ns";
import { appendJsonl } from "../lib/io.js";
import { DATA, SCRIPTS } from "../lib/paths.js";

/** Managers the daemon starts again by itself when they're missing. */
const MANAGERS: string[] = [
  SCRIPTS.hackManager,
  SCRIPTS.gangManager,
  SCRIPTS.goManager,
  SCRIPTS.stocksManager,
  SCRIPTS.bladeburnerManager,
  SCRIPTS.hacknetManager,
];

export async function main(ns: NS): Promise<void> {
  for (const p of ns.ps("home")) if (MANAGERS.includes(p.filename)) ns.kill(p.pid);
  // the daemon returns from main() right after exec'ing us; wait until it's gone
  for (let i = 0; i < 100 && ns.ps("home").some((p) => p.filename === SCRIPTS.daemon); i++) await ns.sleep(50);
  for (const p of ns.ps("home")) if (p.filename === SCRIPTS.daemon) ns.kill(p.pid);
  const pid = ns.exec(SCRIPTS.daemon, "home");
  appendJsonl(ns, DATA.events, { t: Date.now(), kind: "start", msg: pid ? "restarted on new build" : "restart failed: couldn't exec daemon.js" });
}
