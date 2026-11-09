// Daemon-side sleeve management via the call proxy (sleeve functions cost 4 GB each,
// so they never live in the daemon itself).
import type { NS, SleevePerson, SleeveTask } from "@ns";
import { call, callEach } from "./call.js";
import type { FactionData } from "./plan/data.js";
import { decideSleeves, sameAssignment, type Assignment, type RecoveryConfig, type SleeveInfo } from "./plan/sleeves.js";

/** One sleeve's numbers for data/sleeves.txt (shock-recovery analysis). */
export interface SleeveRow {
  i: number;
  shock: number;
  sync: number;
  task: string;
  /** formula rep/s for its faction work (formulas don't model shock — that's what we test) */
  predictedRep?: number;
  faction?: string;
  /** Bladeburner contract completions so far on the current task */
  bbCompleted?: number;
}

export interface SleeveReport {
  count: number;
  assignments: Assignment[];
  changed: string[];
  augsBought: number;
  rows: SleeveRow[];
}

/** Bladeburner contracts sleeves may take, best rank first (one sleeve each). */
const BB_CONTRACTS = ["Retirement", "Bounty Hunter", "Tracking"];

export interface SleeveOptions {
  recovery?: RecoveryConfig;
  /** help Bladeburner with contracts (in the division, black ops left) */
  bladeburner?: boolean;
  bbMinChance?: number;
}

const describe = (a: Assignment | null): string =>
  !a
    ? "idle"
    : a.kind === "faction"
      ? `faction:${a.faction}:${a.type}`
      : a.kind === "crime"
        ? `crime:${a.crime}`
        : a.kind === "bladeburner"
          ? `bladeburner:${a.contract ?? a.action}`
          : "recovery";

function normalise(t: SleeveTask | null): Assignment | null {
  if (!t) return null;
  if (t.type === "FACTION") return { kind: "faction", faction: t.factionName, type: t.factionWorkType };
  if (t.type === "CRIME") return { kind: "crime", crime: t.crimeType };
  if (t.type === "RECOVERY") return { kind: "recovery" };
  if (t.type === "BLADEBURNER")
    return t.actionType === "Contracts"
      ? { kind: "bladeburner", action: "Take on contracts", contract: t.actionName }
      : { kind: "bladeburner", action: t.actionName };
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
  opts: SleeveOptions = {},
): Promise<SleeveReport> {
  const n = (await call<number>(ns, "sleeve.getNumSleeves")) ?? 0;
  if (n === 0) return { count: 0, assignments: [], changed: [], augsBought: 0, rows: [] };
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

  // Bladeburner contracts with work left, and each sleeve's chance at them
  let contracts: string[] = [];
  if (opts.bladeburner && !needKarma) {
    const counts = await callEach<number>(ns, "bladeburner.getActionCountRemaining", BB_CONTRACTS.map((c) => ["Contracts", c]));
    contracts = BB_CONTRACTS.filter((_, k) => (counts[k] ?? 0) >= 1);
    const pairs = idx.flatMap((i) => contracts.map((c) => [i, c] as const));
    const ch = await callEach<[number, number]>(
      ns,
      "bladeburner.getActionEstimatedSuccessChance",
      pairs.map(([i, c]) => ["Contracts", c, i]),
    );
    pairs.forEach(([i, c], k) => ((sleeves[i].bbChance ??= {})[c] = ch[k]?.[0] ?? 0));
  }

  const plan = decideSleeves({
    sleeves,
    needKarma,
    targets,
    favorTargets,
    playerFaction,
    recovery: opts.recovery,
    bladeburner: contracts.length ? { contracts, minChance: opts.bbMinChance ?? 0.7 } : null,
  });

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
    await callEach(
      ns,
      "sleeve.setToBladeburnerAction",
      byKind("bladeburner").map((i) => {
        const a = plan[i] as { action: string; contract?: string };
        return a.contract ? [i, a.action, a.contract] : [i, a.action];
      }),
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
      const what =
        a.kind === "faction"
          ? `${a.faction} (${a.type})`
          : a.kind === "crime"
            ? a.crime
            : a.kind === "bladeburner"
              ? `Bladeburner ${a.contract ?? a.action}`
              : `shock recovery (shock ${(sleeves[i].shock).toFixed(1)})`;
      changed.push(`sleeve ${i}: ${what}${failed ? " — FAILED" : ""}`);
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

  const rows: SleeveRow[] = idx.map((i) => {
    const a = plan[i];
    const t = tasks[i] as (SleeveTask & { tasksCompleted?: number }) | null;
    return {
      i,
      shock: persons[i]?.shock ?? 0,
      sync: persons[i]?.sync ?? 0,
      task: describe(a),
      ...(a.kind === "faction" ? { faction: a.faction, predictedRep: sleeves[i].gains[a.faction]?.[a.type] ?? 0 } : {}),
      ...(t?.type === "BLADEBURNER" ? { bbCompleted: t.tasksCompleted ?? 0 } : {}),
    };
  });
  return { count: n, assignments: plan, changed, augsBought, rows };
}
