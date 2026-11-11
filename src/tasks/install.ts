// Spends everything and installs augmentations, then restarts daemon.js.
// args: JSON {reason, buy: [faction, aug][], donate: [faction, $][], final?}
//
// Order: donations needed for planned augs → planned augs (already in the
// cheapest order) → home RAM (persists within the BitNode) → NeuroFlux Governor
// levels with whatever is left (donating for its rep where possible) → install.
// A `final` install is The Red Pill: buy it first, then dump the surplus into
// NeuroFlux Governor (home RAM only gets what NFG cannot use). Those NFG levels
// still apply to the final w0r1d hack.
import type { FactionName, NS } from "@ns";
import { appendJsonl, writeJson } from "../lib/io.js";
import { NFG, RED_PILL } from "../lib/plan/data.js";
import { DATA, SCRIPTS } from "../lib/paths.js";

interface InstallArgs {
  reason: string;
  buy: [string, string][];
  donate: [string, number][];
  /** The Red Pill install: buy it first, then spend all remaining cash on NeuroFlux. */
  final?: boolean;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  // args[0] is the task result file (unused: this script never returns)
  const a = JSON.parse(String(ns.args[1])) as InstallArgs;
  const final = a.final === true;
  const sing = ns.singularity;
  const bought: string[] = [];
  const money = () => ns.getPlayer().money;

  // installing wipes stock positions without paying them out: sell everything first
  // (the daemon killed stocks/manager.js before starting us)
  const S = ns.stock;
  if (S.hasTixApiAccess())
    for (const sym of S.getSymbols()) {
      const [long, , short] = S.getPosition(sym);
      if (long > 0) S.sellStock(sym, long);
      if (short > 0) S.sellShort(sym, short);
    }

  // after selling stocks, so the spend is the install's own cash outlay
  const moneyBefore = money();
  for (const [f, amt] of a.donate) if (amt <= money()) sing.donateToFaction(f as FactionName, amt);
  const planned = final ? a.buy.filter(([, aug]) => aug === RED_PILL) : a.buy;
  for (const [f, aug] of planned) if (sing.purchaseAugmentation(f as FactionName, aug)) bought.push(aug);

  if (final) {
    const owned = sing.getOwnedAugmentations(true);
    const installed = sing.getOwnedAugmentations(false);
    // Do not spend optional cash if the Red Pill purchase failed, or if it is already
    // installed and this final install would only waste a reset.
    if (installed.includes(RED_PILL) || !owned.includes(RED_PILL)) return;
  }

  const upgradeHomeRam = () => {
    for (let i = 0; i < 20; i++) {
      const c = sing.getUpgradeHomeRamCost();
      if (c > money() || !sing.upgradeHomeRam()) break;
    }
  };

  // NeuroFlux: from the joined faction with the most rep. On the final Red Pill install
  // this is where every remaining dollar goes; the levels still help the w0r1d hack.
  const factions = ns.getPlayer().factions.filter((f) => sing.getAugmentationsFromFaction(f).includes(NFG));
  let nfg = 0;
  const canDonate = (f: string) => sing.getFactionFavor(f as FactionName) >= ns.getFavorToDonate();
  const repPerDollar = ns.fileExists("Formulas.exe", "home")
    ? ns.formulas.reputation.repFromDonation(1e9, ns.getPlayer()) / 1e9
    : 0;
  const buyNfg = () => {
    for (let i = 0; i < 200 && factions.length; i++) {
      const f = factions.sort((x, y) => sing.getFactionRep(y) - sing.getFactionRep(x))[0] as FactionName;
      const price = sing.getAugmentationPrice(NFG);
      if (price > money()) break;
      const gap = sing.getAugmentationRepReq(NFG) - sing.getFactionRep(f);
      if (gap > 0) {
        const donation = canDonate(f) && repPerDollar > 0 ? gap / repPerDollar : Infinity;
        if (donation + price > money() || !sing.donateToFaction(f, donation)) break;
      }
      if (!sing.purchaseAugmentation(f, NFG)) break;
      nfg++;
    }
  };

  // A final install has no future run: dump the surplus into NFG first. Home RAM only
  // gets whatever the NFG price/rep ladder leaves behind.
  if (final) {
    buyNfg();
    upgradeHomeRam();
  } else {
    upgradeHomeRam();
    buyNfg();
  }

  const queued = sing.getOwnedAugmentations(true).length - sing.getOwnedAugmentations(false).length;
  const moneyAfter = money();
  const spent = Math.max(0, moneyBefore - moneyAfter);
  // events.txt is capped; this file survives so the next run record can say what was bought
  writeJson(ns, DATA.lastInstall, {
    t: Date.now(),
    bought,
    nfg,
    queued,
    reason: a.reason,
    moneyBefore,
    moneyAfter,
    spent,
  });
  appendJsonl(ns, DATA.events, {
    t: Date.now(),
    kind: "install",
    msg: `installing ${queued} augs (${bought.length} planned + ${nfg} NeuroFlux): ${a.reason}`,
    data: { bought, nfg, queued, reason: a.reason, spent },
  });
  if (queued > 0) sing.installAugmentations(SCRIPTS.daemon);
}
