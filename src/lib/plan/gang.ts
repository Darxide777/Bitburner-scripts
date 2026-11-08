// Gang decisions. Pure logic → 0 GB (gain estimates are injected, so this is
// unit-testable without the game).
//
// Per gang update:
//   - training: members below a stat floor train (fast after ascension resets stats)
//   - territory: while we don't own everything, the strongest share of members build
//     power ("Territory Warfare"); clashes are engaged once we'd win every one with
//     at least `warfareMinChance`
//   - work: everyone else does the task with the best gain for the current mode —
//     "respect" (→ gang-faction rep, i.e. augs) or "money"
//   - wanted: if the wanted penalty is eating gains, the least valuable workers switch
//     to Vigilante Justice / Ethical Hacking until wanted level stops rising
//   - ascension: when a member's multiplier gain clears a threshold that shrinks as
//     their multiplier grows (cheap gains early, only big jumps late); one per update
import type { GangGenInfo, GangMemberInfo, GangTaskStats } from "@ns";

export type GangMode = "respect" | "money";

export interface GangConfig {
  mode: GangMode;
  warfareMinChance: number;
  /** Fraction of members building territory power while territory < 100%. */
  territoryShare: number;
  /** Members train until their main stat (avg combat, or hack) reaches this. */
  trainMin: number;
  /** Tolerated wanted penalty (fraction of gains lost) before reducing wanted level. */
  maxWantedPenalty: number;
  /** $ fraction per item for normal equipment / for augmentations (which survive ascension). */
  equipBudget: number;
  augBudget: number;
}

export const DEFAULT_GANG: GangConfig = {
  mode: "respect",
  warfareMinChance: 0.6,
  territoryShare: 0.25,
  trainMin: 250,
  maxWantedPenalty: 0.03,
  equipBudget: 0.01,
  augBudget: 0.05,
};

export interface Gain {
  respect: number;
  money: number;
  wanted: number;
}

export interface GangInput {
  gang: GangGenInfo;
  members: GangMemberInfo[];
  tasks: GangTaskStats[];
  /** Per-second gains for a member doing a task (wraps ns.formulas.gang). */
  gain: (m: GangMemberInfo, t: GangTaskStats) => Gain;
  /** Rival gangs that still hold territory, with our chance to win a clash. */
  rivals: { name: string; territory: number; chance: number }[];
  /** getAscensionResult per member (undefined = can't ascend yet). */
  ascension: Record<string, Record<string, number> | undefined>;
}

export interface GangDecision {
  tasks: Record<string, string>;
  ascend: string[];
  warfare: boolean;
  wantedRate: number;
  notes: string[];
}

const COMBAT = ["str", "def", "dex", "agi"] as const;

export function mainStat(m: GangMemberInfo, hacking: boolean): number {
  return hacking ? m.hack : COMBAT.reduce((s, k) => s + m[k], 0) / COMBAT.length;
}

export function mainAscMult(m: GangMemberInfo, hacking: boolean): number {
  return hacking ? m.hack_asc_mult : COMBAT.reduce((s, k) => s + m[`${k}_asc_mult`], 0) / COMBAT.length;
}

/** Ascension multiplier ratio needed before ascending, given the current multiplier. */
export function ascendThreshold(currentMult: number): number {
  if (currentMult < 2) return 1.6;
  if (currentMult < 10) return 1.35;
  if (currentMult < 50) return 1.2;
  return 1.1;
}

export function decideGang(input: GangInput, cfg: GangConfig = DEFAULT_GANG): GangDecision {
  const { gang, members, tasks } = input;
  const hacking = gang.isHacking;
  const notes: string[] = [];
  const train = hacking ? "Train Hacking" : "Train Combat";
  const cool = hacking ? "Ethical Hacking" : "Vigilante Justice";
  const fitting = tasks.filter((t) => (hacking ? t.isHacking : t.isCombat) && (t.baseRespect > 0 || t.baseMoney > 0));
  const metric = (g: Gain) => (cfg.mode === "respect" ? g.respect : g.money);

  const out: Record<string, string> = {};
  const best = new Map<string, { task: GangTaskStats; g: Gain }>();
  for (const m of members) {
    let top: { task: GangTaskStats; g: Gain } | null = null;
    for (const t of fitting) {
      const g = input.gain(m, t);
      if (!top || metric(g) > metric(top.g)) top = { task: t, g };
    }
    if (top) best.set(m.name, top);
  }

  // 1. training
  const ready = members.filter((m) => mainStat(m, hacking) >= cfg.trainMin);
  for (const m of members) if (!ready.includes(m)) out[m.name] = train;

  // 2. territory
  const ownAll = gang.territory >= 0.9999 || input.rivals.length === 0;
  const minChance = input.rivals.length ? Math.min(...input.rivals.map((r) => r.chance)) : 1;
  const warfare = !ownAll && minChance >= cfg.warfareMinChance;
  if (!ownAll) {
    const k = Math.ceil(ready.length * cfg.territoryShare);
    const strongest = [...ready].sort((a, b) => mainStat(b, hacking) - mainStat(a, hacking)).slice(0, k);
    for (const m of strongest) out[m.name] = "Territory Warfare";
    notes.push(`territory ${(gang.territory * 100).toFixed(1)}%, worst clash chance ${(minChance * 100).toFixed(0)}%`);
  }

  // 3. work
  const workers = ready.filter((m) => !out[m.name]);
  for (const m of workers) out[m.name] = best.get(m.name)?.task.name ?? train;

  // 4. wanted control: while the penalty is too high, cool down the least valuable workers
  const rateOf = (m: GangMemberInfo) => {
    const task = out[m.name];
    const t = tasks.find((x) => x.name === task);
    return t ? input.gain(m, t).wanted : 0;
  };
  let wantedRate = members.reduce((s, m) => s + rateOf(m), 0);
  const penalty = 1 - gang.wantedPenalty;
  if (penalty > cfg.maxWantedPenalty && wantedRate >= 0) {
    const byValue = [...workers].sort((a, b) => metric(best.get(a.name)!.g) - metric(best.get(b.name)!.g));
    const coolTask = tasks.find((t) => t.name === cool);
    for (const m of byValue) {
      if (wantedRate < 0 || !coolTask) break;
      wantedRate -= rateOf(m);
      out[m.name] = cool;
      wantedRate += input.gain(m, coolTask).wanted;
    }
    notes.push(`wanted penalty ${(penalty * 100).toFixed(1)}% → cooling down`);
  }

  // 5. ascension (at most one per update, and never a member carrying a big share of respect)
  const ascend: string[] = [];
  const candidates = members
    .map((m) => {
      const r = input.ascension[m.name];
      if (!r) return null;
      const ratio = hacking ? r.hack : COMBAT.reduce((s, k) => s + (r[k] ?? 1), 0) / COMBAT.length;
      return { m, ratio, need: ascendThreshold(mainAscMult(m, hacking)) };
    })
    .filter((x): x is { m: GangMemberInfo; ratio: number; need: number } => !!x && x.ratio >= x.need)
    .filter((x) => x.m.earnedRespect <= gang.respect * 0.3 || members.length >= 12)
    .sort((a, b) => b.ratio / b.need - a.ratio / a.need);
  if (candidates[0]) ascend.push(candidates[0].m.name);

  return { tasks: out, ascend, warfare, wantedRate, notes };
}
