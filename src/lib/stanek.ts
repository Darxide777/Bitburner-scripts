// Daemon-side Stanek's Gift management (all API calls via the call proxy).
//
//   accept   at BitNode start (only possible before any non-NeuroFlux aug is bought/installed)
//   layout   solve once per grid size; apply when the board is empty, or when it is clearly
//            worse and uncharged (right after an install, when charges reset anyway)
//   charge   after every install: each fragment a few times with ONE big process on home
//            (core bonus; highestCharge counts a single call's threads). RAM is reclaimed
//            from hacking gently, by raising the home reserve until it is free.
import type { ActiveFragment, BitNodeMultipliers, Fragment, NS } from "@ns";
import { call, callEach } from "./call.js";
import type { FactionData } from "./plan/data.js";
import { NFG } from "./plan/data.js";
import {
  BOOSTER,
  cells,
  coreBonus,
  DEFAULT_STANEK_WEIGHTS,
  fragmentEffect,
  neighbors,
  scoreLayout,
  solveLayout,
  type Placement,
} from "./plan/stanek.js";

export const CHARGER = "stanek/charge.js";
const GENESIS = "Stanek's Gift - Genesis";

export interface StanekConfig {
  enabled: boolean;
  /** Fraction of home RAM the charger may use. ln(threads) scaling makes 50% ≈ 94% of the full-home effect. */
  ramShare: number;
  /** Charges per fragment per install. numCharge only adds ((n+1)/5)^0.07, so a few is plenty. */
  rounds: number;
  /** Re-layout only if the solved layout is at least this much better. */
  relayoutGain: number;
  weights: Record<number, number>;
}
export const DEFAULT_STANEK: StanekConfig = {
  enabled: true,
  ramShare: 0.5,
  rounds: 5,
  relayoutGain: 1.03,
  weights: DEFAULT_STANEK_WEIGHTS,
};

const TYPE_NAMES: Record<number, string> = {
  3: "hack speed",
  4: "hack money",
  5: "grow",
  6: "hacking",
  7: "str",
  8: "def",
  9: "dex",
  10: "agi",
  11: "cha",
  12: "hacknet $",
  13: "hacknet cost",
  14: "rep",
  15: "work $",
  16: "crime",
  17: "bladeburner",
};

export interface StanekStatus {
  state: "no SF13" | "missed" | "accepted" | "disabled";
  width: number;
  height: number;
  fragments: number;
  layoutScore: number;
  bestScore: number;
  charging: boolean;
  waitingForRam: boolean;
  /** effect bonus per fragment type, e.g. { rep: 0.24 } = +24% */
  bonus: Record<string, number>;
  /** extra home RAM the daemon should hold back so the charger can start */
  reserveGB: number;
}

const cache: {
  defs: Fragment[] | null;
  solved: Map<string, { placements: Placement[]; score: number }>;
  bnMult: number | null;
  waitingSince: number;
} = { defs: null, solved: new Map(), bnMult: null, waitingSince: 0 };

export async function manageStanek(
  ns: NS,
  data: FactionData,
  homeCores: number,
  cfg: StanekConfig,
  event: (k: string, m: string, d?: unknown) => void,
  /** home RAM the daemon's own tasks need; the charger never takes it (small homes early in a node) */
  keepFreeGB = 0,
): Promise<StanekStatus> {
  const status: StanekStatus = {
    state: "accepted",
    width: 0,
    height: 0,
    fragments: 0,
    layoutScore: 0,
    bestScore: 0,
    charging: false,
    waitingForRam: false,
    bonus: {},
    reserveGB: 0,
  };
  if (!(data.sourceFiles["13"] > 0)) return { ...status, state: "no SF13" };
  if (!cfg.enabled) return { ...status, state: "disabled" };

  // ---- accept ----
  if (!data.installed.includes(GENESIS)) {
    const eligible = [...data.installed, ...data.queued].every((a) => a === NFG);
    if (!eligible) return { ...status, state: "missed" };
    if (await call<boolean>(ns, "stanek.acceptGift")) event("stanek", "accepted Stanek's Gift");
    return status;
  }

  // ---- layout ----
  const W = (await call<number>(ns, "stanek.giftWidth")) ?? 0;
  const H = (await call<number>(ns, "stanek.giftHeight")) ?? 0;
  cache.defs ??= (await call<Fragment[]>(ns, "stanek.fragmentDefinitions")) ?? [];
  const defs = cache.defs;
  let active = (await call<ActiveFragment[]>(ns, "stanek.activeFragments")) ?? [];
  const key = `${W}x${H}:${JSON.stringify(cfg.weights)}`;
  let solved = cache.solved.get(key);
  if (!solved) {
    solved = solveLayout(defs, W, H, cfg.weights);
    cache.solved.set(key, solved);
  }
  const current = scoreLayout(defs, W, H, active, cfg.weights);
  const uncharged = active.every((f) => f.highestCharge === 0);
  if (active.length === 0 || (uncharged && solved.score > current * cfg.relayoutGain)) {
    await call(ns, "stanek.clearGift");
    const ok = await callEach<boolean>(ns, "stanek.placeFragment", solved.placements.map((p) => [p.x, p.y, p.rotation, p.id]));
    event("stanek", `placed ${ok.filter(Boolean).length}/${solved.placements.length} fragments (score ${current.toFixed(2)} → ${solved.score.toFixed(2)})`);
    active = (await call<ActiveFragment[]>(ns, "stanek.activeFragments")) ?? [];
  }
  Object.assign(status, {
    width: W,
    height: H,
    fragments: active.length,
    layoutScore: scoreLayout(defs, W, H, active, cfg.weights),
    bestScore: solved.score,
  });

  // ---- effects (for the dashboard) ----
  if (cache.bnMult === null) {
    const m = await call<BitNodeMultipliers>(ns, "getBitNodeMultipliers");
    cache.bnMult = m?.StaneksGiftPowerMultiplier ?? 1;
  }
  const byId = new Map(defs.map((d) => [d.id, d]));
  const cellOwner = new Map<string, ActiveFragment>();
  for (const f of active)
    for (const [cx, cy] of cells(byId.get(f.id)!, f.rotation)) cellOwner.set(`${f.x + cx},${f.y + cy}`, f);
  const stats = active.filter((f) => byId.get(f.id)?.type !== BOOSTER);
  for (const f of stats) {
    const d = byId.get(f.id)!;
    const boosters = new Set<ActiveFragment>();
    for (const [nx, ny] of neighbors(d, f.rotation)) {
      const o = cellOwner.get(`${f.x + nx},${f.y + ny}`);
      if (o && byId.get(o.id)?.type === BOOSTER) boosters.add(o);
    }
    let boost = 1;
    for (const b of boosters) boost *= byId.get(b.id)!.power;
    const name = TYPE_NAMES[d.type] ?? String(d.type);
    const e = fragmentEffect(f.highestCharge, f.numCharge, d.power, boost, cache.bnMult);
    status.bonus[name] = (1 + (status.bonus[name] ?? 0)) * e - 1;
  }

  // ---- charging ----
  if (ns.isRunning(CHARGER, "home")) {
    status.charging = true;
    return status;
  }
  const ramPer = ns.getScriptRam(CHARGER, "home");
  if (ramPer <= 0 || stats.length === 0) return status;
  const homeMax = ns.getServerMaxRam("home");
  const desired = Math.floor(Math.min(homeMax * cfg.ramShare, homeMax - keepFreeGB) / ramPer);
  const effTarget = desired * coreBonus(homeCores);
  const todo = stats.filter((f) => f.highestCharge < effTarget * 0.5 || f.numCharge < cfg.rounds);
  if (!todo.length || desired < 1) {
    cache.waitingSince = 0;
    return status;
  }
  const free = homeMax - ns.getServerUsedRam("home") - keepFreeGB;
  const fit = Math.floor(free / ramPer);
  cache.waitingSince ||= Date.now();
  const waited = Date.now() - cache.waitingSince;
  // launch at full size when the RAM is free, or with ≥25% of it after waiting 5 minutes
  if (fit >= desired * 0.98 || (waited > 5 * 60_000 && fit >= desired * 0.25)) {
    const threads = Math.min(desired, fit);
    const roots = todo.map((f) => [f.x, f.y]);
    if (ns.exec(CHARGER, "home", { threads }, cfg.rounds, JSON.stringify(roots))) {
      event("stanek", `charging ${todo.length} fragment(s) ×${cfg.rounds} with ${threads} threads`);
      status.charging = true;
      cache.waitingSince = 0;
      return status;
    }
  }
  status.waitingForRam = true;
  status.reserveGB = desired * ramPer;
  return status;
}
