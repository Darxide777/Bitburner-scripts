// Gang manager: runs every gang update. Recruits, buys equipment, ascends, assigns
// tasks and toggles territory warfare (decisions in lib/plan/gang.ts).
// Steered by data/gang-config.txt (the daemon sets mode: "respect" while the gang
// faction still has rep-gated augs we want, otherwise "money").
import type { GangMemberInfo, GangTaskStats, NS } from "@ns";
import { readJson, writeJson } from "../lib/io.js";
import { DEFAULT_GANG, decideGang, type GangConfig } from "../lib/plan/gang.js";
import { DATA } from "../lib/paths.js";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const G = ns.gang;
  if (!G.inGang()) return;
  const taskStats: GangTaskStats[] = G.getTaskNames().map((t) => G.getTaskStats(t));
  const equipment = G.getEquipmentNames().map((name) => ({
    name,
    type: G.getEquipmentType(name),
    stats: G.getEquipmentStats(name) as Record<string, number | undefined>,
  }));
  let recruitNo = 0;

  while (true) {
    await G.nextUpdate();
    const cfg: GangConfig = { ...DEFAULT_GANG, ...readJson<Partial<GangConfig>>(ns, DATA.gangConfig, {}) };
    const gang = G.getGangInformation();
    const bought: string[] = [];

    // ---- recruit ----
    while (G.canRecruitMember()) {
      let name = `m${recruitNo++}`;
      while (G.getMemberNames().includes(name)) name = `m${recruitNo++}`;
      if (!G.recruitMember(name)) break;
    }

    let members: GangMemberInfo[] = G.getMemberNames().map((n) => G.getMemberInformation(n));

    // ---- equipment (cheapest first; augmentations survive ascension so get a bigger budget) ----
    const relevant = gang.isHacking ? ["hack"] : ["str", "def", "dex", "agi"];
    const shopping = equipment
      .filter((e) => relevant.some((k) => (e.stats[k] ?? 1) > 1))
      .map((e) => ({ ...e, cost: G.getEquipmentCost(e.name) }))
      .sort((a, b) => a.cost - b.cost);
    for (const e of shopping) {
      const budget = ns.getServerMoneyAvailable("home") * (e.type === "Augmentation" ? cfg.augBudget : cfg.equipBudget);
      if (e.cost > budget) break;
      for (const m of members) {
        if (m.upgrades.includes(e.name) || m.augmentations.includes(e.name)) continue;
        if (e.cost > ns.getServerMoneyAvailable("home") * (e.type === "Augmentation" ? cfg.augBudget : cfg.equipBudget))
          break;
        if (G.purchaseEquipment(m.name, e.name)) bought.push(`${e.name} → ${m.name}`);
      }
    }
    if (bought.length) members = G.getMemberNames().map((n) => G.getMemberInformation(n));

    // ---- decide ----
    const others = G.getAllGangInformation();
    const rivals = Object.entries(others)
      .filter(([name, o]) => name !== gang.faction && o.territory > 0)
      .map(([name, o]) => ({ name, territory: o.territory, chance: G.getChanceToWinClash(name) }));
    const ascension: Record<string, Record<string, number> | undefined> = {};
    for (const m of members) ascension[m.name] = G.getAscensionResult(m.name) as Record<string, number> | undefined;
    const F = ns.formulas.gang;
    const d = decideGang(
      {
        gang,
        members,
        tasks: taskStats,
        gain: (m, t) => ({
          respect: F.respectGain(gang, m, t),
          money: F.moneyGain(gang, m, t),
          wanted: F.wantedLevelGain(gang, m, t),
        }),
        rivals,
        ascension,
      },
      cfg,
    );

    // ---- act ----
    const ascended: string[] = [];
    for (const name of d.ascend) if (G.ascendMember(name)) ascended.push(name);
    for (const m of members) {
      const task = ascended.includes(m.name) ? (gang.isHacking ? "Train Hacking" : "Train Combat") : d.tasks[m.name];
      if (task && m.task !== task) G.setMemberTask(m.name, task);
    }
    if (gang.territoryWarfareEngaged !== d.warfare) G.setTerritoryWarfare(d.warfare);

    const taskCounts: Record<string, number> = {};
    for (const t of Object.values(d.tasks)) taskCounts[t] = (taskCounts[t] ?? 0) + 1;
    writeJson(ns, DATA.gang, {
      t: Date.now(),
      faction: gang.faction,
      mode: cfg.mode,
      members: members.length,
      respect: gang.respect,
      respectRate: gang.respectGainRate,
      moneyRate: gang.moneyGainRate,
      wantedPenalty: gang.wantedPenalty,
      territory: gang.territory,
      power: gang.power,
      warfare: d.warfare,
      tasks: taskCounts,
      ascended,
      bought,
      notes: d.notes,
    });
  }
}
