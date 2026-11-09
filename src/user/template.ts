// Template for your own module. Copy it to src/user/<name>.ts, write your logic, and add it to
// data/config.txt:   {"userModules": [{"script": "user/<name>.js"}]}
// The daemon starts it when missing, holds home RAM for it, and restarts it on new builds.
//
// Read the daemon's context every loop (data/context.txt, see DaemonContext in daemon.ts):
//   uiBusy          casino.js / infiltrate.js own the screen: don't navigate or change work
//   installPlanned  an augment install is about to happen
//   money, homeFree, workFaction, sinceInstallMs, …
// To keep the hacking manager off servers you use, write data/user-reserve.txt:
//   writeJson(ns, DATA.userReserve, { hosts: ["some-server"] })
// Keep RAM low: route expensive API calls through lib/call.ts (one temporary script per
// function) instead of referencing them here.
import type { NS } from "@ns";
import { readJson } from "../lib/io.js";
import { DATA } from "../lib/paths.js";
import type { DaemonContext } from "../daemon.js";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  while (true) {
    const ctx = readJson<Partial<DaemonContext>>(ns, DATA.context, {});
    if (!ctx.uiBusy) {
      // your logic here
    }
    await ns.sleep(10_000);
  }
}
