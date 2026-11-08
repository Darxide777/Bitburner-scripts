// Daemon-side sleeve management via the call proxy (sleeve functions cost 4 GB each,
// so they never live in the daemon itself).
import type { NS, SleevePerson, SleeveTask } from "@ns";
import { call, callEach } from "./call.js";
import type { FactionData } from "./plan/data.js";
import { decideSleeves, sameAssignment, type Assignment, type SleeveInfo } from "./plan/sleeves.js";

export interface SleeveReport {
  count: number;
  assignments: Assignment[];
  changed: string[];
  augsBought: number;
}

function normalise(t: SleeveTask | null): Assignment | null {
  if (!t) return null;
  if (t.type === "FACTION") return { kind: "faction", faction: t.factionName, type: t.factionWorkType };
  if (t.type === "CRIME") return { kind: "crime", crime: t.crimeType };
  if (t.type === "RECOVERY") return { kind: "recovery" };
  return null;
}

/**
 * Plan and apply sleeve tasks. `targets` = factions to grind in priority order;
 * `playerFaction` = the faction the player will work for (sleeves must avoid it).
 * `augBudget` = fraction of money a single sleeve aug may cost.
 */
export async function manageSleeves(
  ns: NS,
  data: FactionData,
  targets: string[],
  favorTargets: string[],
  playerFaction: string | null,
  needKarma: boolean,
  augBudget = 0.001,
): Promise<SleeveReport> {
  const n = (await call<number>(ns, "sleeve.getNumSleeves")) ?? 0;
  if (n === 0) return { count: 0, assignments: [], changed: [], augsBought: 0 };
  const idx = [...Array(n).keys()];
  const persons = (await callEach<SleevePerson>(ns, "sleeve.getSleeve", idx.map((i) => [i]))) as SleevePerson[];
  const tasks = await callEach<SleeveTask | null>(ns, "sleeve.getTask", idx.map((i) => [i]));

  // rep/s for every sleeve × target faction × work type
  const combos: [number, string, string][] = [];
  const allTargets = [...new Set([...targets, ...favorTargets])];
  for (const i of idx)
    for (const f of allTargets) for (const w of data.factions[f]?.workTypes ?? []) combos.push([i, f, w]);
  const gains = combos.length
    ? await callEach<{ reputation: number }>(
        ns,
        "formulas.work.factionGains",
        combos.map(([i, f, w]) => [persons[i], w, data.factions[f].favor]),
      )
    : [];
  const chances = await callEach<number>(
    ns,
    "formulas.work.crimeSuccessChance",
    idx.flatMap((i) => [[persons[i], "Homicide"], [persons[i], "Heist"]]),
  );

  const sleeves: SleeveInfo[] = idx.map((i) => ({
    i,
    shock: persons[i]?.shock ?? 0,
    current: normalise(tasks[i] ?? null),
    homicideChance: chances[2 * i] ?? 0,
    heistChance: chances[2 * i + 1] ?? 0,
    gains: {},
  }));
  combos.forEach(([i, f, w], k) => {
    const g = sleeves[i].gains;
    (g[f] ??= {})[w] = (gains[k]?.reputation ?? 0) * 5;
  });

  const plan = decideSleeves({ sleeves, needKarma, targets, favorTargets, playerFaction });

  // apply: move changing sleeves to idle first so faction slots are free, then assign
  const changing = idx.filter((i) => !sameAssignment(sleeves[i].current, plan[i]));
  const changed: string[] = [];
  if (changing.length) {
    await callEach(ns, "sleeve.setToIdle", changing.map((i) => [i]));
    const byKind = (k: Assignment["kind"]) => changing.filter((i) => plan[i].kind === k);
    await callEach(ns, "sleeve.setToShockRecovery", byKind("recovery").map((i) => [i]));
    await callEach(
      ns,
      "sleeve.setToCommitCrime",
      byKind("crime").map((i) => [i, (plan[i] as { crime: string }).crime]),
    );
    const fw = byKind("faction");
    const ok = await callEach<boolean>(
      ns,
      "sleeve.setToFactionWork",
      fw.map((i) => {
        const a = plan[i] as { faction: string; type: string };
        return [i, a.faction, a.type];
      }),
    );
    for (const i of changing) {
      const a = plan[i];
      const failed = a.kind === "faction" && !ok[fw.indexOf(i)];
      changed.push(
        `sleeve ${i}: ${a.kind === "faction" ? `${a.faction} (${a.type})` : a.kind === "crime" ? a.crime : "shock recovery"}${failed ? " — FAILED" : ""}`,
      );
    }
  }

  // sleeve augs: cheap ones only, and only for unshocked sleeves (the game requires shock 0)
  let augsBought = 0;
  const unshocked = idx.filter((i) => (persons[i]?.shock ?? 1) === 0);
  if (unshocked.length) {
    const offers = await callEach<{ name: string; cost: number }[]>(ns, "sleeve.getSleevePurchasableAugs", unshocked.map((i) => [i]));
    const buys: [number, string][] = [];
    let money = data.money;
    unshocked.forEach((i, k) => {
      for (const a of [...(offers[k] ?? [])].sort((x, y) => x.cost - y.cost)) {
        if (a.cost > money * augBudget) break;
        buys.push([i, a.name]);
        money -= a.cost;
      }
    });
    const res = await callEach<boolean>(ns, "sleeve.purchaseSleeveAug", buys);
    augsBought = res.filter(Boolean).length;
  }

  return { count: n, assignments: plan, changed, augsBought };
}
