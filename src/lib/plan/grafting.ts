// Grafting evaluation (logging only for now). Pure logic → 0 GB.
//
// From the game's source (Grafting/EntropyAccumulation.ts, GraftingWork.tsx):
//   - a grafted aug applies immediately and stays until the BitNode ends (installs keep it)
//   - every graft adds an Entropy stack that also lasts until the BitNode ends: all gain
//     multipliers ×0.98 per stack, hacknet costs ÷0.98 — unless The Congruity Implant is
//     owned, which also resets Entropy to 0 when grafted
//   - grafting takes the player's time (like faction work)
// So a graft is worth  value(aug) − value(one Entropy stack), in the planner's aug-value
// units, for `hours` of the player's time — compared with getting it from a faction.

import { augValue } from "./factions.js";

export const CONGRUITY = "The Congruity Implant";
export const ENTROPY_EFFECT = 0.98;

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
  const cost = opts.hasCongruity ? 0 : entropyCost(weights);
  return inputs
    .map((g) => {
      const value = augValue(g.stats, weights) + (opts.bonus?.[g.aug] ?? 0);
      // Congruity removes all current entropy (and stops future stacks): its stats plus that relief
      const net = g.aug === CONGRUITY ? value + (opts.entropy ?? 0) * entropyCost(weights) : value - cost;
      const hours = g.timeMs / 3600e3;
      const factionEtaH = g.factionEtaSec === null ? null : g.factionEtaSec / 3600;
      return {
        aug: g.aug,
        price: g.price,
        hours,
        value,
        net,
        netPerHour: hours > 0 ? net / hours : 0,
        factionEtaH,
        faster: factionEtaH === null || hours < factionEtaH,
      };
    })
    .sort((a, b) => b.netPerHour - a.netPerHour);
}
