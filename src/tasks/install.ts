// Spends everything and installs augmentations, then restarts daemon.js.
// args: JSON {reason, buy: [faction, aug][], donate: [faction, $][], final?}
//
// Order: donations needed for planned augs → planned augs (already in the
// cheapest order) → home RAM (persists within the BitNode) → NeuroFlux Governor
// levels with whatever is left (donating for its rep where possible) → install.
// A `final` install is The Red Pill: buy only it, and skip NeuroFlux, which is lost
// with the BitNode. Home RAM is kept because it persists and helps the w0r1d hack.
import type { FactionName, NS } from "@ns";
import { appendJsonl, writeJson } from "../lib/io.js";
import { NFG, RED_PILL } from "../lib/plan/data.js";
import { DATA, SCRIPTS } from "../lib/paths.js";

interface InstallArgs {
  reason: string;
  buy: [string, string][];
  donate: [string, number][];
  /** The Red Pill install: buy nothing else and skip NeuroFlux. */
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

  for (let i = 0; i < 20; i++) {
    const c = sing.getUpgradeHomeRamCost();
    if (c > money() || !sing.upgradeHomeRam()) break;
  }

  // NeuroFlux: from the joined faction with the most rep. Never on the final Red Pill
  // install: those levels die with the BitNode and only delay the install.
  const factions = final ? [] : ns.getPlayer().factions.filter((f) => sing.getAugmentationsFromFaction(f).includes(NFG));
  let nfg = 0;
  const canDonate = (f: string) => sing.getFactionFavor(f as FactionName) >= ns.getFavorToDonate();
  const repPerDollar = ns.fileExists("Formulas.exe", "home")
    ? ns.formulas.reputation.repFromDonation(1e9, ns.getPlayer()) / 1e9
    : 0;
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
