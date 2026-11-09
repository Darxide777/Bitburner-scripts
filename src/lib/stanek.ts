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
import { allHosts, isHacknet } from "./net.js";
import {
  BOOSTER,
  cells,
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
  /** Rounds per fragment for a "peak" charge (sets highestCharge with the biggest block). */
  rounds: number;
  /**
   * Keep charging forever after the peak charge. numCharge grows ~1 per full-size call and
   * the bonus scales with ((n+1)/5)^0.07: ×1.01 at 5 rounds, ×1.4 after an hour, ×1.75
   * after a day. Runs on the biggest block that is at most maxPoolShare of all RAM.
   */
  continuous: boolean;
  /** largest share of the total RAM pool a continuous charger may hold */
  maxPoolShare: number;
  /**
   * While Church of the Machine God augs are rep-gated: extra continuous chargers on more
   * cloud servers, up to this share of all RAM (main charger included). Church rep only
   * comes from charging, ~threads^0.95 per call, so total charging threads is what counts.
   */
  churchPoolShare: number;
  /** Re-layout only if the solved layout is at least this much better. */
  relayoutGain: number;
  weights: Record<number, number>;
}
export const DEFAULT_STANEK: StanekConfig = {
  enabled: true,
  ramShare: 0.5,
  rounds: 5,
  continuous: true,
  maxPoolShare: 0.25,
  churchPoolShare: 0.35,
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
  /** non-home servers the hacking manager must leave free for chargers */
  reserveHosts: string[];
  /** extra chargers (Church rep mode): hosts running or waiting for one */
  extraChargers: string[];
  /** where the charger runs, its mode and effective threads */
  charger: { host: string; mode: "peak" | "continuous"; threads: number } | null;
  /** per chargeable fragment: highestCharge and numCharge (to watch them grow) */
  charges: { type: string; highestCharge: number; numCharge: number }[];
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
  /** Church of the Machine God augs are rep-gated: add extra chargers (churchPoolShare) */
  churchRep = false,
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
    reserveHosts: [],
    extraChargers: [],
    charger: null,
    charges: [],
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
    status.charges.push({ type: name, highestCharge: f.highestCharge, numCharge: f.numCharge });
  }

  // ---- charging ----
  // One charger process at a time. "peak": `rounds` calls per fragment on the biggest block
  // (home's ramShare with its core bonus, or a whole cloud server), whenever that block
  // is ≥2× the fragments' highestCharge. "continuous" (otherwise): charge forever on the
  // biggest block within maxPoolShare of all RAM, to grow numCharge.
  const ramPer = ns.getScriptRam(CHARGER, "home");
  if (ramPer <= 0 || stats.length === 0) return status;
  const homeMax = ns.getServerMaxRam("home");
  const hosts = allHosts(ns);
  const blocks = [
    // highestCharge is the raw thread count: home's cores don't count (observed: 512 threads
    // on 6 cores → highestCharge 512), so blocks compare by threads alone
    { host: "home", gb: Math.min(homeMax * cfg.ramShare, homeMax - keepFreeGB), mult: 1 },
    ...hosts.filter((h) => h.startsWith("cloud-")).map((h) => ({ host: h, gb: ns.getServerMaxRam(h), mult: 1 })),
  ]
    .map((b) => ({ ...b, threads: Math.floor(b.gb / ramPer) }))
    .filter((b) => b.threads >= 1)
    .sort((a, b) => b.threads * b.mult - a.threads * a.mult);
  if (!blocks.length) return status;
  const eff = (b: { threads: number; mult: number }) => b.threads * b.mult;
  const pool = hosts.filter((h) => ns.hasRootAccess(h) && !isHacknet(h)).reduce((a, h) => a + ns.getServerMaxRam(h), 0);
  const lowest = Math.min(...stats.map((f) => f.highestCharge));
  const peakBlock = blocks[0];
  const needPeak = lowest < eff(peakBlock) * 0.5 || stats.some((f) => f.numCharge < 1);
  // continuous: a whole server within the share, else a share-sized slice of home (early in a
  // node home is most of the RAM, and Church rep only grows while something charges)
  const share = (churchRep ? cfg.churchPoolShare : cfg.maxPoolShare) * pool;
  const homeBlock = blocks.find((b) => b.host === "home");
  const cloudCont = blocks.find((b) => b.host !== "home" && b.gb <= share) ?? null;
  const homeSlice =
    homeBlock && Math.floor(Math.min(homeBlock.gb, share) / ramPer) >= 1
      ? { ...homeBlock, gb: Math.min(homeBlock.gb, share), threads: Math.floor(Math.min(homeBlock.gb, share) / ramPer) }
      : null;
  const contBlock = !cloudCont ? homeSlice : !homeSlice || cloudCont.threads >= homeSlice.threads ? cloudCont : homeSlice;
  const want = needPeak
    ? { ...peakBlock, mode: "peak" as const }
    : cfg.continuous && contBlock
      ? { ...contBlock, mode: "continuous" as const }
      : null;

  // what's running now (the daemon may have restarted: look, don't trust memory)
  let running: { host: string; pid: number; threads: number; mode: string } | null = null;
  for (const b of blocks) {
    const p = ns.ps(b.host).find((x) => x.filename === CHARGER && x.args[2] !== "extra");
    if (p) {
      running = { host: b.host, pid: p.pid, threads: p.threads * b.mult, mode: Number(p.args[0]) > 0 ? "peak" : "continuous" };
      break;
    }
  }

  // ---- extra chargers (Church rep) ----
  const roots = stats.map((f) => [f.x, f.y]);
  const extras = blocks.flatMap((b) =>
    ns.ps(b.host).filter((x) => x.filename === CHARGER && x.args[2] === "extra").map((x) => ({ host: b.host, pid: x.pid, gb: x.threads * ramPer })),
  );
  if (!churchRep || !cfg.continuous || needPeak) {
    // a peak charge needs everything quiet; outside Church mode they only cost hacking
    for (const x of extras) ns.kill(x.pid);
    if (extras.length) event("stanek", `stopped ${extras.length} extra charger(s)${needPeak ? " for a peak charge" : ""}`);
  } else {
    const mainHosts = new Set([running?.host, want?.host].filter(Boolean));
    let used = extras.reduce((a, x) => a + x.gb, 0) + (want ? want.threads * ramPer : 0);
    status.extraChargers = extras.map((x) => x.host);
    const busy = new Set(extras.map((x) => x.host));
    for (const b of blocks) {
      if (b.host === "home" || mainHosts.has(b.host) || busy.has(b.host)) continue;
      const gb = ns.getServerMaxRam(b.host);
      if (used + gb > pool * cfg.churchPoolShare) continue;
      used += gb;
      status.extraChargers.push(b.host);
      const fit = Math.floor((gb - ns.getServerUsedRam(b.host)) / ramPer);
      if (fit < b.threads * 0.98) continue; // reserved below; starts once hacking has left
      ns.scp(CHARGER, b.host, "home");
      if (ns.exec(CHARGER, b.host, { threads: fit }, 0, JSON.stringify(roots), "extra"))
        event("stanek", `extra charger for Church rep on ${b.host} (${fit} threads)`);
    }
  }
  status.reserveHosts.push(...status.extraChargers);

  if (running) {
    const keep =
      running.mode === "peak" || // finish it (25 s)
      (want?.mode === "continuous" && (want.host === running.host || eff(want) < running.threads * 1.5));
    if (keep) {
      status.charging = true;
      status.charger = { host: running.host, mode: running.mode as "peak" | "continuous", threads: running.threads };
      if (running.host !== "home") status.reserveHosts.push(running.host);
      return status;
    }
    ns.kill(running.pid);
    event("stanek", `stopped the ${running.mode} charger on ${running.host} (moving to a better block)`);
  }
  if (!want) {
    cache.waitingSince = 0;
    return status;
  }

  // start `want` once its RAM is free (hacking is told to leave it), or with ≥25% after 5 min
  const used = ns.getServerUsedRam(want.host);
  const free = want.host === "home" ? homeMax - used - keepFreeGB : ns.getServerMaxRam(want.host) - used;
  const fit = Math.floor(free / ramPer);
  cache.waitingSince ||= Date.now();
  const waited = Date.now() - cache.waitingSince;
  if (fit >= want.threads * 0.98 || (waited > 5 * 60_000 && fit >= want.threads * 0.25)) {
    const threads = Math.min(want.threads, fit);
    if (want.host !== "home") ns.scp(CHARGER, want.host, "home");
    const rounds = want.mode === "peak" ? cfg.rounds : 0; // 0 = forever
    if (ns.exec(CHARGER, want.host, { threads }, rounds, JSON.stringify(roots))) {
      event("stanek", `${want.mode} charging ${roots.length} fragment(s) on ${want.host} with ${threads} threads${want.mode === "peak" ? ` ×${rounds}` : ""}`);
      status.charging = true;
      status.charger = { host: want.host, mode: want.mode, threads: threads * want.mult };
      if (want.host !== "home") status.reserveHosts.push(want.host);
      cache.waitingSince = 0;
      return status;
    }
  }
  status.waitingForRam = true;
  if (want.host === "home") status.reserveGB = want.threads * ramPer;
  else status.reserveHosts.push(want.host);
  return status;
}
