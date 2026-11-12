// Restarts daemon.js (and the long-running managers, so they run new code too) after
// the sync server pushes a new build. The daemon exits right after spawning this.
// args: (result file, unused)
import type { NS } from "@ns";
import { appendJsonl, readJson } from "../lib/io.js";
import { DATA, SCRIPTS } from "../lib/paths.js";

/** Managers the daemon starts again by itself when they're missing. */
const MANAGERS: string[] = [
  SCRIPTS.hackManager,
  SCRIPTS.gangManager,
  SCRIPTS.goManager,
  SCRIPTS.stocksManager,
  SCRIPTS.bladeburnerManager,
  SCRIPTS.hacknetManager,
  SCRIPTS.corpManager,
  SCRIPTS.infiltrate,
];

/** Hack/share workers: their manager is gone, so they may be stopped to make room for the daemon. */
const WORKERS: string[] = [SCRIPTS.hackScript, SCRIPTS.growScript, SCRIPTS.weakenScript, SCRIPTS.shareScript];

const RETRY_MS = 5_000;

export async function main(ns: NS): Promise<void> {
  const event = (msg: string) => appendJsonl(ns, DATA.events, { t: Date.now(), kind: "start", msg });
  // user modules from data/config.txt restart too, so they pick up their new builds
  const users = (readJson<{ userModules?: { script: string }[] }>(ns, DATA.config, {}).userModules ?? []).map((u) => u.script);
  for (const p of ns.ps("home")) if (MANAGERS.includes(p.filename) || users.includes(p.filename)) ns.kill(p.pid);
  // the daemon returns from main() right after exec'ing us; wait until it's gone
  for (let i = 0; i < 100 && ns.ps("home").some((p) => p.filename === SCRIPTS.daemon); i++) await ns.sleep(50);
  for (const p of ns.ps("home")) if (p.filename === SCRIPTS.daemon) ns.kill(p.pid);

  // Nothing else brings the daemon back, so keep trying until it runs. A single failed
  // exec (home full during the Red Pill push, or a build whose daemon.js doesn't compile)
  // used to leave the game without a daemon until someone noticed.
  const free = () => ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
  let lastWhy = "";
  for (let attempt = 0; ; attempt++) {
    if (attempt) await ns.sleep(RETRY_MS);
    // re-read every attempt: the sync server may push a fixed build meanwhile
    const need = ns.getScriptRam(SCRIPTS.daemon, "home");
    let why: string;
    if (need <= 0) why = `${SCRIPTS.daemon} has no RAM cost (missing, or the build has an error)`;
    else {
      // biggest workers first → fewest kills; the restarted hack manager relaunches batches
      const workers = ns
        .ps("home")
        .filter((p) => WORKERS.includes(p.filename))
        .sort((a, b) => b.threads - a.threads);
      for (const p of workers) {
        if (free() >= need) break;
        ns.kill(p.pid);
      }
      if (ns.exec(SCRIPTS.daemon, "home")) {
        event(attempt ? `restarted on new build after ${attempt} retries` : "restarted on new build");
        return;
      }
      why = `needs ${need.toFixed(2)} GB, ${free().toFixed(2)} GB free on home`;
    }
    if (why !== lastWhy) event(`restart failed: couldn't exec ${SCRIPTS.daemon} (${why}); retrying every ${RETRY_MS / 1000} s`);
    lastWhy = why;
  }
}
