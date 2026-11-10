// Hacking manager: turns every rooted server's RAM into money.
//
// Strategy ("shotgun" HWGW): a target is only ever attacked from a prepped state
// (min security, max money). Each cycle, all batches for the target are exec'd in
// one synchronous burst — the game cannot change state in between, so Formulas
// timings are exact — and each job gets an additionalMsec so that within every
// batch the operations land Hack → Weaken → Grow → Weaken, `spacing` ms apart.
// The cycle ends when the last weaken lands; the target is re-checked and either
// batched again or re-prepped. Multiple targets run concurrently, best first,
// sharing one RAM pool. Leftover RAM can be lent to factions via share().
//
// Steered by data/config.txt (written by the daemon/planner):
//   homeReserve (GB kept free on home), maxTargets, spacing (ms), shareFrac (0..1)
import type { NS, Player, Server } from "@ns";
import { allHosts, isHacknet } from "../lib/net.js";
import { readJson, writeJson } from "../lib/io.js";
import { DATA, SCRIPTS } from "../lib/paths.js";

export interface HackConfig {
  homeReserve: number;
  maxTargets: number;
  spacing: number;
  /** Fraction of leftover RAM to spend on share() (0 disables). */
  shareFrac: number;
  /** servers to leave alone entirely (e.g. the Stanek charger's) */
  skipHosts?: string[];
  /** share of the pool running weaken for hacking XP (0 = off), see xpFarm() */
  xpShare?: number;
}
export const DEFAULT_HACK_CONFIG: HackConfig = { homeReserve: 32, maxTargets: 6, spacing: 60, shareFrac: 0 };

interface Batch {
  h: number;
  w1: number;
  g: number;
  w2: number;
  ram: number;
  frac: number;
}
interface TargetState {
  busyUntil: number;
  mode: "prep" | "batch" | "wait";
  batches: number;
  frac: number;
  expected: number; // $ expected this cycle
  cycleMs: number;
}
type Pool = Map<string, number>; // host -> free GB

const FRACTIONS = [0.9, 0.75, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05, 0.02, 0.01];
const MAX_BATCHES = 400;
const CONFIG_RELOAD_MS = 1_000;
const HOST_REFRESH_MS = 10_000;

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const workers = [SCRIPTS.hackScript, SCRIPTS.growScript, SCRIPTS.weakenScript, SCRIPTS.shareScript];
  const ramOf = {
    h: ns.getScriptRam(SCRIPTS.hackScript),
    g: ns.getScriptRam(SCRIPTS.growScript),
    w: ns.getScriptRam(SCRIPTS.weakenScript),
    s: ns.getScriptRam(SCRIPTS.shareScript),
  };
  const states = new Map<string, TargetState>();
  const ready = new Set<string>(); // hosts that have the worker files
  let cfg: HackConfig = DEFAULT_HACK_CONFIG;
  let skipHosts = new Set<string>();
  let hosts: string[] = [];
  let lastConfig = 0;
  let lastHosts = 0;
  let ranked: string[] = [];
  let lastRank = 0;
  let lastStatus = 0;
  let tag = 0;
  let shareThreads = 0;
  const xp: XpState = { busyUntil: 0, target: "", threads: 0, expPerSec: 0 };

  const hasFormulas = () => ns.fileExists("Formulas.exe", "home");

  while (true) {
    const now = Date.now();
    if (now - lastConfig >= CONFIG_RELOAD_MS) {
      cfg = { ...DEFAULT_HACK_CONFIG, ...readJson<Partial<HackConfig>>(ns, DATA.hackConfig, {}) };
      skipHosts = new Set(cfg.skipHosts ?? []);
      lastConfig = now;
    }
    if (now - lastHosts >= HOST_REFRESH_MS || hosts.length === 0) {
      hosts = allHosts(ns);
      lastHosts = now;
    }
    const player = ns.getPlayer();

    // ---- RAM pool ----
    const pool: Pool = new Map();
    let managedRam = 0;
    for (const h of hosts) {
      if (isHacknet(h) || skipHosts.has(h)) continue;
      try {
        if (!ns.hasRootAccess(h)) continue;
        const max = ns.getServerMaxRam(h);
        if (max <= 0) continue;
        if (!ready.has(h) || !ns.fileExists(SCRIPTS.weakenScript, h)) {
          if (h !== "home") ns.scp(workers, h, "home");
          ready.add(h);
        }
        managedRam += Math.max(0, max - (h === "home" ? cfg.homeReserve : 0));
        const free = max - ns.getServerUsedRam(h) - (h === "home" ? cfg.homeReserve : 0);
        if (free >= 1.6) pool.set(h, free);
      } catch {
        ready.delete(h);
      }
    }
    const poolTotal = sum(pool);
    // Reserve a share of total managed RAM for XP, not just a share of whatever happens
    // to be free after the money batches: otherwise long-lived batches starve the farm.
    const xpBudget = (cfg.xpShare ?? 0) > 0 ? managedRam * (cfg.xpShare ?? 0) : 0;

    // ---- target ranking (every 30s) ----
    if (now - lastRank > 30_000 || ranked.length === 0) {
      ranked = rankTargets(ns, hosts, player, ramOf, hasFormulas(), skipHosts);
      lastRank = now;
    }

    // ---- hacking XP (a hacking level gates something): weaken the best XP-per-second server ----
    if (xpBudget > 0 && hasFormulas() && Date.now() >= xp.busyUntil) {
      xpFarm(ns, hosts, skipHosts, player, pool, xpBudget, ramOf.w, xp, () => tag++);
    }
    const xpCommitted = Date.now() < xp.busyUntil ? xp.threads * ramOf.w : 0;
    const xpReserve = Math.max(0, xpBudget - xpCommitted);

    // ---- schedule targets, best first ----
    // Leave the unspent XP reserve out of the money pool, so new batches can only use
    // RAM above it. Existing batches keep running; as they finish, XP can claim its share.
    const workPool: Pool = new Map(pool);
    let reserve = xpReserve;
    for (const [h, free] of workPool) {
      if (reserve <= 0) break;
      const take = Math.min(free, reserve);
      workPool.set(h, free - take);
      reserve -= take;
    }
    if (hasFormulas()) {
      for (const target of ranked.slice(0, cfg.maxTargets)) {
        const st = states.get(target) ?? { busyUntil: 0, mode: "wait", batches: 0, frac: 0, expected: 0, cycleMs: 0 };
        states.set(target, st);
        if (Date.now() < st.busyUntil) continue;
        // don't batch the server the XP round is weakening right now
        if (xp.target === target && Date.now() < xp.busyUntil) continue;
        if (sum(workPool) < 8) break;
        const s = ns.getServer(target);
        const prepped =
          (s.hackDifficulty ?? 0) <= (s.minDifficulty ?? 0) + 0.01 && (s.moneyAvailable ?? 0) >= (s.moneyMax ?? 0) * 0.999;
        if (prepped) batch(ns, target, s, player, workPool, cfg, ramOf, st, () => tag++);
        else prep(ns, target, s, player, workPool, cfg, ramOf, st, () => tag++);
      }
    }

    // ---- share leftover RAM with factions ----
    shareThreads = 0;
    if (cfg.shareFrac > 0) {
      for (const [h, free] of workPool) {
        const t = Math.floor((free * cfg.shareFrac) / ramOf.s);
        if (t < 1) continue;
        if (ns.exec(SCRIPTS.shareScript, h, { threads: t, temporary: true }, 1, tag++)) shareThreads += t;
      }
    }

    // ---- status ----
    if (Date.now() - lastStatus > 5_000) {
      lastStatus = Date.now();
      const targets = [...states.entries()]
        .filter(([h]) => ranked.slice(0, cfg.maxTargets).includes(h))
        .map(([host, st]) => ({
          host,
          mode: st.mode,
          batches: st.batches,
          frac: st.frac,
          ratePerSec: st.mode === "batch" && st.cycleMs > 0 ? (st.expected / st.cycleMs) * 1000 : 0,
          busyFor: Math.max(0, st.busyUntil - Date.now()),
        }));
      writeJson(ns, DATA.hackStatus, {
        t: Date.now(),
        formulas: hasFormulas(),
        poolTotal,
        poolFreeAfter: sum(pool),
        shareThreads,
        xp: (cfg.xpShare ?? 0) > 0 ? { ...xp } : null,
        expectedPerSec: targets.reduce((a, t) => a + t.ratePerSec, 0),
        targets,
      });
      ns.clearLog();
      ns.print(`pool ${poolTotal.toFixed(0)}GB  share threads ${shareThreads}`);
      for (const t of targets)
        ns.print(`${t.host.padEnd(20)} ${t.mode.padEnd(5)} x${String(t.batches).padEnd(4)} ${(t.frac * 100).toFixed(0)}%  $${t.ratePerSec.toExponential(2)}/s`);
    }
    await ns.sleep(200);
  }
}

function sum(pool: Pool): number {
  let s = 0;
  for (const v of pool.values()) s += v;
  return s;
}

function mockPrepped(ns: NS, host: string): Server {
  const s = ns.getServer(host);
  s.hackDifficulty = s.minDifficulty;
  s.moneyAvailable = s.moneyMax;
  return s;
}

function calcBatch(ns: NS, s: Server, p: Player, f: number, ramOf: Record<string, number>): Batch | null {
  const F = ns.formulas.hacking;
  const per = F.hackPercent(s, p);
  if (per <= 0) return null;
  let h = Math.max(1, Math.floor(f / per));
  if (h * per >= 0.99) h = Math.max(1, Math.floor(0.99 / per));
  const frac = Math.min(0.99, h * per);
  const wPer = F.weakenEffect(1, 1);
  const w1 = Math.ceil(ns.hackAnalyzeSecurity(h) / wPer);
  const after: Server = { ...s, moneyAvailable: Math.max(0, (s.moneyMax ?? 0) * (1 - frac)) };
  const g = Math.ceil(F.growThreads(after, p, s.moneyMax ?? 0, 1) * 1.05) + 1;
  const w2 = Math.ceil(ns.growthAnalyzeSecurity(g) / wPer);
  return { h, w1, g, w2, frac, ram: h * ramOf.h + g * ramOf.g + (w1 + w2) * ramOf.w };
}

/** Rank hackable servers by expected $ per GB-second of RAM at a moderate hack fraction. */
function rankTargets(
  ns: NS,
  hosts: string[],
  p: Player,
  ramOf: Record<string, number>,
  formulas: boolean,
  skip: ReadonlySet<string>,
): string[] {
  const scored: [string, number][] = [];
  for (const h of hosts) {
    if (h === "home" || isHacknet(h) || skip.has(h)) continue;
    try {
      if (!ns.hasRootAccess(h)) continue;
      if (ns.getServerMaxMoney(h) <= 0 || ns.getServerRequiredHackingLevel(h) > p.skills.hacking) continue;
      if (!formulas) {
        scored.push([h, ns.getServerMaxMoney(h) / ns.getServerRequiredHackingLevel(h)]);
        continue;
      }
      const s = mockPrepped(ns, h);
      if (s.purchasedByPlayer) continue;
      const b = calcBatch(ns, s, p, 0.5, ramOf);
      if (!b) continue;
      const chance = ns.formulas.hacking.hackChance(s, p);
      const wt = ns.formulas.hacking.weakenTime(s, p);
      scored.push([h, ((s.moneyMax ?? 0) * b.frac * chance) / (b.ram * wt)]);
    } catch {
      continue;
    }
  }
  return scored.sort((a, b) => b[1] - a[1]).map(([h]) => h);
}

/** Place `threads` of `script` across the pool (splitting allowed). Returns pids or null if it didn't fit. */
function place(
  ns: NS,
  pool: Pool,
  script: string,
  threads: number,
  ramPer: number,
  args: (string | number)[],
): number[] | null {
  if (threads <= 0) return [];
  const pids: number[] = [];
  let left = threads;
  // biggest hosts first → fewer processes
  const hostsBySize = [...pool.entries()].sort((a, b) => b[1] - a[1]);
  for (const [h, free] of hostsBySize) {
    const fit = Math.min(left, Math.floor(free / ramPer));
    if (fit < 1) continue;
    const pid = ns.exec(script, h, { threads: fit, temporary: true }, ...args);
    if (!pid) continue;
    pids.push(pid);
    pool.set(h, free - fit * ramPer);
    left -= fit;
    if (left === 0) return pids;
  }
  for (const pid of pids) ns.kill(pid);
  return null;
}

function batch(
  ns: NS,
  target: string,
  s: Server,
  p: Player,
  pool: Pool,
  cfg: HackConfig,
  ramOf: Record<string, number>,
  st: TargetState,
  nextTag: () => number,
): void {
  const F = ns.formulas.hacking;
  const W = F.weakenTime(s, p);
  const G = F.growTime(s, p);
  const H = F.hackTime(s, p);
  const S = cfg.spacing;
  const maxByTime = Math.max(1, Math.floor((W * 0.4) / (4 * S)));
  const free = sum(pool);

  let best: { b: Batch; n: number; value: number } | null = null;
  for (const f of FRACTIONS) {
    const b = calcBatch(ns, s, p, f, ramOf);
    if (!b) continue;
    // keep a 10% margin for fragmentation across hosts
    const n = Math.min(MAX_BATCHES, maxByTime, Math.floor((free * 0.9) / b.ram));
    if (n < 1) continue;
    const value = n * b.frac;
    if (!best || value > best.value) best = { b, n, value };
  }
  if (!best) {
    st.mode = "wait";
    return;
  }

  const { b } = best;
  const firstLand = Date.now() + W + 300;
  let launched = 0;
  for (let i = 0; i < best.n; i++) {
    const land = firstLand + i * 4 * S;
    const id = nextTag();
    const jobs: [string, number, number, number][] = [
      [SCRIPTS.hackScript, b.h, ramOf.h, land - H],
      [SCRIPTS.weakenScript, b.w1, ramOf.w, land + S - W],
      [SCRIPTS.growScript, b.g, ramOf.g, land + 2 * S - G],
      [SCRIPTS.weakenScript, b.w2, ramOf.w, land + 3 * S - W],
    ];
    const pids: number[] = [];
    let ok = true;
    for (const [script, threads, ramPer, startAt] of jobs) {
      const add = Math.max(0, startAt - Date.now());
      const r = place(ns, pool, script, threads, ramPer, [target, add, id]);
      if (!r) {
        ok = false;
        break;
      }
      pids.push(...r);
    }
    if (!ok) {
      // roll back the partial batch so it can't desync the target
      for (const pid of pids) ns.kill(pid);
      break;
    }
    launched++;
  }

  const chance = F.hackChance(s, p);
  st.mode = launched > 0 ? "batch" : "wait";
  st.batches = launched;
  st.frac = b.frac;
  st.expected = launched * b.frac * (s.moneyMax ?? 0) * chance;
  st.busyUntil = launched > 0 ? firstLand + (launched - 1) * 4 * S + 3 * S + 300 : Date.now() + 1000;
  st.cycleMs = Math.max(1, st.busyUntil - Date.now());
}

function prep(
  ns: NS,
  target: string,
  s: Server,
  p: Player,
  pool: Pool,
  cfg: HackConfig,
  ramOf: Record<string, number>,
  st: TargetState,
  nextTag: () => number,
): void {
  const F = ns.formulas.hacking;
  const S = cfg.spacing;
  const wPer = F.weakenEffect(1, 1);
  const min = s.minDifficulty ?? 0;
  const w1 = Math.ceil(((s.hackDifficulty ?? 0) - min) / wPer);
  const atMin: Server = { ...s, hackDifficulty: min };
  let g = (s.moneyAvailable ?? 0) < (s.moneyMax ?? 0) ? Math.ceil(F.growThreads(atMin, p, s.moneyMax ?? 0, 1) * 1.05) : 0;
  let w2 = g > 0 ? Math.ceil(ns.growthAnalyzeSecurity(g) / wPer) : 0;

  // durations are fixed by the server's *current* security at launch
  const W = F.weakenTime(s, p);
  const G = F.growTime(s, p);
  const land = Date.now() + Math.max(W, G) + 300;
  const id = nextTag();

  let free = sum(pool) * 0.95;
  const w1Fit = Math.min(w1, Math.floor(free / ramOf.w));
  free -= w1Fit * ramOf.w;
  if (w1Fit === w1 && g > 0) {
    const need = g * ramOf.g + w2 * ramOf.w;
    if (need > free) {
      const r = Math.max(0, free / need);
      g = Math.floor(g * r);
      w2 = Math.ceil(ns.growthAnalyzeSecurity(g) / wPer);
    }
  } else {
    g = 0;
    w2 = 0;
  }
  if (w1Fit + g + w2 === 0) {
    st.mode = "wait";
    return;
  }

  const pids: number[] = [];
  const launch = (script: string, threads: number, ramPer: number, args: (string | number)[]): boolean => {
    const placed = place(ns, pool, script, threads, ramPer, args);
    if (!placed) {
      for (const pid of pids) ns.kill(pid);
      return false;
    }
    pids.push(...placed);
    return true;
  };
  const fail = () => {
    st.mode = "wait";
    st.batches = 0;
    st.frac = 0;
    st.expected = 0;
    st.busyUntil = Date.now() + 1_000;
    st.cycleMs = 1_000;
  };

  if (!launch(SCRIPTS.weakenScript, w1Fit, ramOf.w, [target, Math.max(0, land - W - Date.now()), id])) {
    fail();
    return;
  }
  if (g > 0) {
    if (!launch(SCRIPTS.growScript, g, ramOf.g, [target, Math.max(0, land + S - G - Date.now()), id])) {
      fail();
      return;
    }
    if (!launch(SCRIPTS.weakenScript, w2, ramOf.w, [target, Math.max(0, land + 2 * S - W - Date.now()), id])) {
      fail();
      return;
    }
  }
  st.mode = "prep";
  st.batches = 0;
  st.frac = 0;
  st.expected = 0;
  st.busyUntil = land + 2 * S + 300;
  st.cycleMs = st.busyUntil - Date.now();
}

interface XpState {
  busyUntil: number;
  target: string;
  threads: number;
  /** hacking XP per second this round is expected to give */
  expPerSec: number;
}

/**
 * Hacking XP: weaken gives the same XP per thread as a successful hack and never touches
 * money, so a block of weaken threads on the server with the most XP per second of weaken
 * time (formulas: hackExp at min security / weakenTime) farms XP. Batch targets are fair
 * game when they are the best XP source; the scheduler skips one while its round runs.
 */
function xpFarm(
  ns: NS,
  hosts: string[],
  skip: ReadonlySet<string>,
  player: Player,
  pool: Pool,
  budgetGB: number,
  ramPer: number,
  xp: XpState,
  nextTag: () => number,
): void {
  const F = ns.formulas.hacking;
  let best: { host: string; rate: number; time: number } | null = null;
  for (const h of hosts) {
    if (h === "home" || isHacknet(h) || skip.has(h)) continue;
    try {
      if (!ns.hasRootAccess(h)) continue;
      const s = ns.getServer(h);
      if (s.purchasedByPlayer || (s.requiredHackingSkill ?? 0) > player.skills.hacking) continue;
      const atMin = { ...s, hackDifficulty: s.minDifficulty };
      const time = F.weakenTime(atMin, player);
      const rate = F.hackExp(atMin, player) / Math.max(1, time);
      if (time > 0 && (!best || rate > best.rate)) best = { host: h, rate, time };
    } catch {
      continue;
    }
  }
  if (!best) return;
  const threads = Math.floor(budgetGB / ramPer);
  if (threads < 1) return;
  // place what fits (smaller rounds are fine: XP is per thread)
  let placed = 0;
  for (const [h, free] of [...pool.entries()].sort((a, b) => b[1] - a[1])) {
    const fit = Math.min(threads - placed, Math.floor(free / ramPer));
    if (fit < 1) continue;
    if (ns.exec(SCRIPTS.weakenScript, h, { threads: fit, temporary: true }, best.host, 0, nextTag())) {
      pool.set(h, free - fit * ramPer);
      placed += fit;
    }
    if (placed >= threads) break;
  }
  if (!placed) return;
  // the current security may be above min: the round takes as long as its actual weaken
  const actual = ns.formulas.hacking.weakenTime(ns.getServer(best.host), player);
  Object.assign(xp, { busyUntil: Date.now() + actual + 200, target: best.host, threads: placed, expPerSec: best.rate * placed });
}
