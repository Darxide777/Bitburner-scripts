// Bladeburner decisions. Pure logic → 0 GB; bladeburner/manager.ts gathers the state and acts.
//
// Priorities, in order:
//   1. rest (Hyperbolic Regeneration Chamber) below `staminaLow` until `staminaHigh`:
//      under 50% stamina every success chance is halved
//   2. Diplomacy while the city's chaos is above `chaosMax` (chaos cuts success chances)
//   3. Field Analysis while success estimates are too uncertain to rank actions
//   4. the next Black Op once rank allows it and it's (nearly) certain to succeed
//   5. the contract/operation with the most expected rank per second
//   6. otherwise Incite Violence when contracts have run dry, else Training
// Rank becomes Bladeburners faction rep, which is the only way to earn it (no donations).

export const TYPE = { general: "General", contract: "Contracts", op: "Operations", blackOp: "Black Operations" } as const;
export type BbType = (typeof TYPE)[keyof typeof TYPE];

export interface BbAction {
  type: BbType;
  name: string;
}

export interface BbActionInfo extends BbAction {
  /** estimated success chance [min, max] */
  chance: [number, number];
  count: number;
  /** ms */
  time: number;
  rankGain: number;
}

export interface BbState {
  stamina: [number, number];
  chaos: number;
  rank: number;
  /** contracts and operations */
  actions: BbActionInfo[];
  /** next Black Op, with its info, or null when all are done */
  nextBlackOp: (BbActionInfo & { reqRank: number }) | null;
  /** were we resting last decision (stamina hysteresis) */
  resting: boolean;
}

export interface BbConfig {
  staminaLow: number;
  staminaHigh: number;
  chaosMax: number;
  /** Field Analysis while any candidate's chance spread (max - min) exceeds this */
  maxSpread: number;
  minChanceContract: number;
  minChanceOp: number;
  minChanceBlackOp: number;
  /** operations never chosen: Raid needs communities and adds chaos, Stealth Retirement has tiny rank */
  skipOps: string[];
  /** Operation Daedalus ends the BitNode; the hacking path (w0r1d_d43m0n) handles that */
  allowFinalBlackOp: boolean;
}

export const DEFAULT_BB: BbConfig = {
  staminaLow: 0.55,
  staminaHigh: 0.95,
  chaosMax: 50,
  maxSpread: 0.05,
  minChanceContract: 0.7,
  minChanceOp: 0.8,
  minChanceBlackOp: 0.95,
  skipOps: ["Raid", "Stealth Retirement Operation"],
  allowFinalBlackOp: false,
};

export const FINAL_BLACK_OP = "Operation Daedalus";

export interface BbDecision {
  action: BbAction;
  why: string;
  resting: boolean;
}

const general = (name: string): BbAction => ({ type: TYPE.general, name });

export function chooseAction(st: BbState, cfg: BbConfig = DEFAULT_BB): BbDecision {
  // 1. stamina
  const [cur, max] = st.stamina;
  const frac = max > 0 ? cur / max : 1;
  if (frac < cfg.staminaLow || (st.resting && frac < cfg.staminaHigh))
    return { action: general("Hyperbolic Regeneration Chamber"), why: `stamina ${(frac * 100).toFixed(0)}%`, resting: true };

  // 2. chaos
  if (st.chaos > cfg.chaosMax) return { action: general("Diplomacy"), why: `chaos ${st.chaos.toFixed(0)}`, resting: false };

  const usable = st.actions.filter((a) => a.count >= 1 && !(a.type === TYPE.op && cfg.skipOps.includes(a.name)));

  // 3. uncertainty
  const spread = Math.max(0, ...usable.map((a) => a.chance[1] - a.chance[0]));
  if (spread > cfg.maxSpread)
    return { action: general("Field Analysis"), why: `estimates ±${(spread * 50).toFixed(0)}%`, resting: false };

  // 4. black op
  const bo = st.nextBlackOp;
  if (bo && st.rank >= bo.reqRank && (bo.name !== FINAL_BLACK_OP || cfg.allowFinalBlackOp) && bo.chance[0] >= cfg.minChanceBlackOp)
    return { action: { type: TYPE.blackOp, name: bo.name }, why: `black op (${pct(bo.chance[0])})`, resting: false };

  // 5. best expected rank per second
  const min = (a: BbActionInfo) => (a.type === TYPE.op ? cfg.minChanceOp : cfg.minChanceContract);
  const rate = (a: BbActionInfo) => (a.chance[0] * a.rankGain) / Math.max(1, a.time);
  const best = usable.filter((a) => a.chance[0] >= min(a)).sort((a, b) => rate(b) - rate(a))[0];
  if (best)
    return {
      action: { type: best.type, name: best.name },
      why: `${pct(best.chance[0])}, ${(rate(best) * 1000).toFixed(3)} rank/s`,
      resting: false,
    };

  // 6. fallbacks
  const contractsLeft = st.actions.some((a) => a.type === TYPE.contract && a.count >= 1);
  if (!contractsLeft) return { action: general("Incite Violence"), why: "no contracts left", resting: false };
  return { action: general("Training"), why: "no action likely enough to succeed", resting: false };
}

/** Skill priorities (relative value per skill point spent); Overclock caps at level 90. */
export const SKILL_WEIGHTS: Record<string, number> = {
  "Blade's Intuition": 3, // +3% success, all actions
  "Digital Observer": 3, // +4% success, operations
  Cloak: 2, // +5.5% success, stealth actions
  "Short-Circuit": 2, // +5.5% success, retirement actions
  Overclock: 2.5, // -1% action time
  Reaper: 1.5, // +2% combat stats
  "Evasive System": 1.5, // +4% dex/agi
  Tracer: 1, // +4% success, contracts
  Hyperdrive: 1, // +10% exp
  "Cyber's Edge": 0.5, // +2% max stamina
  "Hands of Midas": 0.2, // contract money
  Datamancer: 0.2, // synthoid data
};
export const SKILL_CAPS: Record<string, number> = { Overclock: 90 };

/**
 * Next skill to buy: the best weight per skill point among those we can afford
 * (`costs`: price of each skill's next level), or null. The manager buys it and asks again.
 */
export function pickSkill(
  points: number,
  levels: Record<string, number>,
  costs: Record<string, number>,
  weights = SKILL_WEIGHTS,
): string | null {
  let pick: string | null = null;
  let bestScore = 0;
  for (const [name, w] of Object.entries(weights)) {
    if ((levels[name] ?? 0) >= (SKILL_CAPS[name] ?? Infinity)) continue;
    const c = costs[name];
    if (!(c > 0) || c > points) continue;
    if (w / c > bestScore) [pick, bestScore] = [name, w / c];
  }
  return pick;
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
