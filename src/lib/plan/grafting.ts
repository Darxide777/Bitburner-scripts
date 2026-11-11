// Grafting evaluation and autoplay choice. Pure logic → 0 GB.
//
// From the game's source (Grafting/EntropyAccumulation.ts, GraftingWork.tsx):
//   - a grafted aug applies immediately and stays until the BitNode ends (installs keep it)
//   - every graft adds an Entropy stack that also lasts until the BitNode ends: all gain
//     multipliers ×0.98 per stack, hacknet costs ÷0.98 — unless The Congruity Implant is
//     owned, which also resets Entropy to 0 when grafted
//   - grafting takes the player's time (like faction work)
// So a graft is worth  value(aug) − value(one Entropy stack), in the planner's aug-value
// units, for `hours` of the player's time — compared with getting it from a faction.
// The caps below keep the cumulative Entropy hit from growing without bound.

import { NFG, RED_PILL } from "./data.js";
import { augValue } from "./factions.js";

export const CONGRUITY = "The Congruity Implant";
export const ENTROPY_EFFECT = 0.98;

export interface GraftingConfig {
  /** Act on the evaluation (false = log only). */
  auto: boolean;
  /** Minimum net aug-value after paying for the Entropy stack. */
  minNet: number;
  /** Minimum net aug-value per graft hour. */
  minNetPerHour: number;
  /** Never graft for longer than this. */
  maxGraftMs: number;
  /** Maximum Entropy stacks after the graft (0 = only a Congruity reset is allowed). */
  maxEntropy: number;
  /** Keep at least this much money after paying the graft price. */
  moneyReserve: number;
  /** Only graft when it beats the faction route (or no faction offers it). */
  onlyIfFaster: boolean;
  /** Focus on the graft (faster; no other multipliers). */
  focus: boolean;
  /** Never graft these: bought at install or cheaply repeatable. */
  skip: string[];
}

export const DEFAULT_GRAFTING: GraftingConfig = {
  auto: true,
  minNet: 0.1,
  minNetPerHour: 0.05,
  maxGraftMs: 12 * 3600_000,
  maxEntropy: 3,
  moneyReserve: 0,
  onlyIfFaster: true,
  focus: true,
  skip: [RED_PILL, NFG],
};

const ENTROPY_GAINS = [
  "hacking_chance", "hacking_speed", "hacking_money", "hacking_grow", "hacking", "strength", "defense", "dexterity",
  "agility", "charisma", "hacking_exp", "strength_exp", "defense_exp", "dexterity_exp", "agility_exp", "charisma_exp",
  "company_rep", "faction_rep", "crime_money", "crime_success", "dnet_money", "hacknet_node_money", "work_money",
  "bladeburner_max_stamina", "bladeburner_stamina_gain", "bladeburner_analysis", "bladeburner_success_chance",
];
const ENTROPY_COSTS = ["hacknet_node_purchase_cost", "hacknet_node_ram_cost", "hacknet_node_core_cost", "hacknet_node_level_cost"];

/** Value lost to one more Entropy stack (positive number, aug-value units). */
export function entropyCost(weights: Record<string, number>): number {
  const stats: Record<string, number> = {};
  for (const k of ENTROPY_GAINS) stats[k] = ENTROPY_EFFECT;
  for (const k of ENTROPY_COSTS) stats[k] = 1 / ENTROPY_EFFECT;
  // augValue clamps at its floor; undo that to get the (negative) raw value
  let raw = 0;
  for (const [k, m] of Object.entries(stats)) {
    const w = weights[k] ?? 0;
    raw += k.endsWith("_cost") ? w * (1 - m) : w * (m - 1);
  }
  return -raw;
}

export interface GraftInput {
  aug: string;
  price: number;
  timeMs: number;
  stats: Record<string, number>;
  /** seconds until a faction route gets it this run (the planner's ETA), null if no faction offers it */
  factionEtaSec: number | null;
}

export interface GraftRow {
  aug: string;
  price: number;
  hours: number;
  value: number;
  /** value minus one Entropy stack (0 cost with The Congruity Implant) */
  net: number;
  netPerHour: number;
  /** value lost to this graft's Entropy stack (0 when Congruity is owned or grafted) */
  entropyCost: number;
  /** Entropy stacks after this graft (0 when Congruity is owned or grafted) */
  entropyAfter: number;
  factionEtaH: number | null;
  /** grafting is faster than the faction route (or the only route) */
  faster: boolean;
}

export function evaluateGrafts(
  inputs: GraftInput[],
  weights: Record<string, number>,
  /** entropy: current stacks (Congruity's grafting removes them all) */
  opts: { hasCongruity: boolean; entropy?: number; bonus?: Record<string, number> },
): GraftRow[] {
  const stackCost = entropyCost(weights);
  const entropy = opts.entropy ?? 0;
  const factor = ENTROPY_EFFECT ** entropy;
  // each stack costs 2% of the current (already entropy-reduced) total
  const cost = stackCost * factor;
  // Congruity removes everything accumulated so far: a geometric series of stack costs
  const relief = stackCost * ((1 - factor) / (1 - ENTROPY_EFFECT));
  return inputs
    .map((g) => {
      const value = augValue(g.stats, weights) + (opts.bonus?.[g.aug] ?? 0);
      // Congruity removes all current entropy (and stops future stacks): its stats plus that relief
      const congruity = g.aug === CONGRUITY;
      const net = congruity ? value + relief : value - (opts.hasCongruity ? 0 : cost);
      const hours = g.timeMs / 3600e3;
      const factionEtaH = g.factionEtaSec === null ? null : g.factionEtaSec / 3600;
      return {
        aug: g.aug,
        price: g.price,
        hours,
        value,
        net,
        netPerHour: hours > 0 ? net / hours : 0,
        entropyCost: opts.hasCongruity || congruity ? 0 : cost,
        entropyAfter: opts.hasCongruity || congruity ? 0 : entropy + 1,
        factionEtaH,
        faster: factionEtaH === null || hours < factionEtaH,
      };
    })
    .sort((a, b) => b.netPerHour - a.netPerHour);
}

export interface GraftChoiceContext {
  /** Cash available now (not stocks: grafting cannot pay with them). */
  money: number;
  installPlanned: boolean;
  owned?: readonly string[];
  queued?: readonly string[];
}

/**
 * Pick the best graft that is actually worth the cumulative Entropy hit and the time.
 * Rows are expected to be sorted by net/hour (evaluateGrafts does that), but we sort
 * defensively so callers can pass filtered/reordered rows.
 */
export function chooseGraft(rows: GraftRow[], cfg: GraftingConfig, ctx: GraftChoiceContext): GraftRow | null {
  if (ctx.installPlanned) return null;
  const skip = new Set([RED_PILL, NFG, ...cfg.skip]);
  const owned = new Set(ctx.owned ?? []);
  const queued = new Set(ctx.queued ?? []);
  for (const r of [...rows].sort((a, b) => b.netPerHour - a.netPerHour)) {
    if (skip.has(r.aug) || owned.has(r.aug) || queued.has(r.aug)) continue;
    // a faction route ready now means the aug comes with the next install for free
    if (r.factionEtaH === 0) continue;
    if (cfg.onlyIfFaster && !r.faster) continue;
    if (!(r.net >= cfg.minNet)) continue;
    if (!(r.netPerHour >= cfg.minNetPerHour)) continue;
    if (!(r.hours * 3600e3 <= cfg.maxGraftMs)) continue;
    if (!(r.price <= ctx.money - cfg.moneyReserve)) continue;
    if (!(r.entropyAfter <= cfg.maxEntropy)) continue;
    return r;
  }
  return null;
}
