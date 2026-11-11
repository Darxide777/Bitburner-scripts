// Infrastructure spending: TOR + darkweb programs, home RAM/cores, cloud servers,
// and (share-only mode) hacknet RAM.
// args: budget ($ this task may spend this call), reserve ($ to keep for augs),
//       [shareHacknetFrac] — when present, reserve this fraction for hacknet RAM.
// Returns a list of human-readable actions taken (logged as events by the daemon).
//
// Priorities (each step only spends what's left of the budget):
//   1. TOR and port openers — unlock more servers to root (cheap, huge value)
//   2. home RAM — persists across augment installs within a BitNode
//   3. cloud servers — buy until the limit, then double the smallest
//   4. hacknet RAM — only in share-only mode, with the reserved fraction plus
//      whatever cloud/home spending could not use (cloud caps shrink with SF12)
//   5. home cores — modest boost to grow/weaken on home (not in share-only mode)
import type { NS, ProgramName } from "@ns";
import { chooseRamUpgrade, type ServerInfo } from "../lib/plan/hacknet.js";
import { task } from "../lib/task-main.js";

const PROGRAMS = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe", "Formulas.exe"];

export async function main(ns: NS): Promise<void> {
  await task(ns, (args) => {
    const sing = ns.singularity;
    const reserve = Math.max(0, Number(args[1]) || 0);
    const shareHacknet = args.length > 2;
    const hacknetFrac = shareHacknet ? Math.max(0, Math.min(1, Number(args[2]) || 0)) : 0;
    let budget = Math.min(Number(args[0]) || 0, Math.max(0, ns.getPlayer().money - reserve));
    const hacknetReserve = budget * hacknetFrac;
    let hacknetBudget = hacknetReserve;
    budget -= hacknetReserve;
    const actions: string[] = [];
    const spend = (cost: number, what: string, buy: () => boolean) => {
      if (cost > budget || !Number.isFinite(cost)) return false;
      if (!buy()) return false;
      budget -= cost;
      actions.push(`${what} ($${ns.format.number(cost)})`);
      return true;
    };

    // 1. TOR + programs
    if (!ns.hasTorRouter()) spend(200_000, "bought TOR router", () => sing.purchaseTor());
    if (ns.hasTorRouter()) {
      for (const prog of PROGRAMS) {
        if (ns.fileExists(prog, "home")) continue;
        const cost = sing.getDarkwebProgramCost(prog as ProgramName);
        if (cost > 0) spend(cost, `bought ${prog}`, () => sing.purchaseProgram(prog as ProgramName));
      }
    }

    // 2. home RAM (repeat while affordable)
    for (let i = 0; i < 10; i++) {
      const cost = sing.getUpgradeHomeRamCost();
      if (!spend(cost, `home RAM → ${ns.format.ram(ns.getServerMaxRam("home") * 2)}`, () => sing.upgradeHomeRam()))
        break;
    }

    // 3. cloud servers
    const cloud = ns.cloud;
    const limit = cloud.getServerLimit();
    const maxRam = cloud.getRamLimit();
    for (let i = 0; i < 25 && budget > 0; i++) {
      const owned = cloud.getServerNames();
      if (owned.length < limit) {
        // largest power-of-two RAM we can afford, at least 8GB
        let r = 8;
        while (r * 2 <= maxRam && cloud.getServerCost(r * 2) <= budget) r *= 2;
        const name = `cloud-${owned.length}`;
        if (!spend(cloud.getServerCost(r), `bought ${name} (${ns.format.ram(r)})`, () => cloud.purchaseServer(name, r) !== ""))
          break;
      } else {
        const smallest = owned
          .map((h) => [h, ns.getServerMaxRam(h)] as const)
          .sort((a, b) => a[1] - b[1])[0];
        if (!smallest || smallest[1] >= maxRam) break;
        const [h, r] = smallest;
        const to = Math.min(maxRam, r * 2);
        if (!spend(cloud.getServerUpgradeCost(h, to), `upgraded ${h} → ${ns.format.ram(to)}`, () => cloud.upgradeServer(h, to)))
          break;
      }
    }

    if (shareHacknet) {
      // Anything cloud/home could not spend (e.g. cloud RAM is capped) becomes
      // hacknet RAM. The hacknet manager is told not to buy while this runs.
      hacknetBudget += budget;
      budget = 0;
      const H = ns.hacknet;
      const servers: ServerInfo[] = [];
      for (let i = 0; i < H.numNodes(); i++) {
        const st = H.getNodeStats(i);
        servers.push({ level: st.level, ram: st.ram, cores: st.cores, production: st.production });
      }
      const costOf = (u: { kind: string; index: number }) =>
        u.kind === "ram"
          ? H.getRamUpgradeCost(u.index, 1)
          : H.numNodes() < H.maxNumNodes()
            ? H.getPurchaseNodeCost()
            : Infinity;
      for (let k = 0; k < 100 && hacknetBudget > 0; k++) {
        const u = chooseRamUpgrade(servers, costOf, hacknetBudget);
        if (!u) break;
        if (u.kind === "ram") {
          if (!H.upgradeRam(u.index, 1)) break;
          servers[u.index].ram *= 2;
          actions.push(`hacknet RAM → ${ns.format.ram(servers[u.index].ram)} ($${ns.format.number(u.cost)})`);
        } else {
          if (H.purchaseNode() < 0) break;
          servers.push({ level: 1, ram: 1, cores: 1, production: 0 });
          actions.push(`bought hacknet server ($${ns.format.number(u.cost)})`);
        }
        hacknetBudget -= u.cost;
      }
    } else {
      // 4. home cores (only with leftover budget)
      spend(sing.getUpgradeHomeCoresCost(), "home cores +1", () => sing.upgradeHomeCores());
    }

    return actions;
  });
}
