// Telemetry probe: collects everything the planner and metrics need in one go.
// Runs once per daemon tick as a temporary script, so its (large) RAM cost is
// only held for a few milliseconds.
import type { NS } from "@ns";
import { task } from "../lib/task-main.js";
import type { Snapshot } from "../lib/types.js";

export async function main(ns: NS): Promise<void> {
  await task(ns, (): Snapshot => {
    const p = ns.getPlayer();
    const reset = ns.getResetInfo();
    const sing = ns.singularity;

    const rep: Record<string, number> = {};
    const favor: Record<string, number> = {};
    for (const f of p.factions) {
      rep[f] = sing.getFactionRep(f);
      favor[f] = sing.getFactionFavor(f);
    }

    let gang: Snapshot["gang"] = null;
    try {
      if (ns.gang.inGang()) {
        const g = ns.gang.getGangInformation();
        gang = {
          faction: g.faction,
          respect: g.respect,
          respectRate: g.respectGainRate,
          moneyRate: g.moneyGainRate,
          territory: g.territory,
          members: ns.gang.getMemberNames().length,
        };
      }
    } catch {
      /* gang API unavailable */
    }

    let sleeves = 0;
    try {
      sleeves = ns.sleeve.getNumSleeves();
    } catch {
      /* no SF10 */
    }

    const home = ns.getServer("home");
    return {
      t: Date.now(),
      node: reset.currentNode,
      lastAugReset: reset.lastAugReset,
      lastNodeReset: reset.lastNodeReset,
      sourceFiles: Object.fromEntries([...reset.ownedSF].map(([k, v]) => [String(k), v])),
      augsInstalled: reset.ownedAugs.size,
      money: p.money,
      hackLevel: p.skills.hacking,
      hackExp: p.exp.hacking,
      karma: p.karma,
      kills: p.numPeopleKilled,
      city: p.city,
      factions: p.factions,
      invites: sing.checkFactionInvitations(),
      rep,
      favor,
      earned: ns.getMoneySources().sinceInstall,
      work: sing.getCurrentWork(),
      homeRam: home.maxRam,
      homeCores: home.cpuCores,
      gang,
      sleeves,
      shareMult: ns.getSharePower(),
    };
  });
}
