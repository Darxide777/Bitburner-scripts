// Hacknet server decisions. Pure logic → 0 GB; hacknet/manager.ts gathers data and acts.
//
// Every hash upgrade is priced in money-equivalent $ so they can be compared per hash:
//   Sell for Money            $1m per purchase (the floor every other use has to beat)
//   Increase Maximum Money    target's $/s × measured gain (default 2%) × time left in the run
//   Reduce Minimum Security   target's $/s × hack-time speedup × time left in the run
//                             (hack/grow/weaken time ∝ 2.5·reqHack·security + 500)
//   Exchange for Bladeburner Rank  seconds of Bladeburner progress saved (+100 rank ÷ measured
//                             rank/s, capped at what's left to Operation Daedalus) × income/s;
//                             nothing while Operation Daedalus is more than a day away
//   Generate Coding Contract  the average measured money reward (≥ 3 samples)
// Server effects are wiped by installs, so "time left" is the expected rest of the run:
// the median of recent run lengths minus the time since the last install.
//
// Production (level / RAM / cores / new servers) is bought by payback time:
//   cost ÷ (extra hashes/s × best $ per hash), and only if it pays back within
//   `paybackFrac` of the time left (installs wipe hacknet servers too).
// In share-only mode RAM is bought by $/GB instead: threads matter, hashes do not.

export const SELL = "Sell for Money";
export const MAX_MONEY = "Increase Maximum Money";
export const MIN_SEC = "Reduce Minimum Security";
export const BB_RANK = "Exchange for Bladeburner Rank";
export const CONTRACT = "Generate Coding Contract";
export const CORP_FUNDS = "Sell for Corporation Funds";

export interface HacknetConfig {
  /** max share of cash per production purchase */
  budgetFrac: number;
  /** production must pay back within this fraction of the run time left */
  paybackFrac: number;
  /** $-value of one second of Bladeburner progress, as a multiple of income/s */
  rankSecondValue: number;
  /**
   * Bladeburner rank is only worth hashes while Operation Daedalus is within this many
   * seconds at the measured rank/s: further out, another route ends the BitNode first.
   */
  rankHorizonSec: number;
  /** don't value anything over less than this (s) */
  minRemainingSec: number;
  /** horizon for corp funds (a corp lasts the whole BitNode), s */
  corpHorizonSec: number;
  /** new corp money earns less than the corp's average dollar */
  corpMarginalFactor: number;
}

export const DEFAULT_HACKNET: HacknetConfig = {
  budgetFrac: 0.25,
  paybackFrac: 0.5,
  rankSecondValue: 1,
  rankHorizonSec: 24 * 3600,
  minRemainingSec: 600,
  corpHorizonSec: 12 * 3600,
  corpMarginalFactor: 0.5,
};

export interface TargetInfo {
  host: string;
  ratePerSec: number;
  minSecurity: number;
  reqHack: number;
}

export interface ValueInput {
  remainingSec: number;
  incomePerSec: number;
  targets: TargetInfo[];
  /** hash cost of the next purchase, by upgrade name */
  costs: Record<string, number>;
  /** measured max-money multiplier per purchase (default 1.02) */
  maxMoneyGain?: number;
  /** min-security multiplier per purchase (default 0.98) */
  minSecMult?: number;
  bladeburner?: { rank: number; rankPerSec: number; finalRank: number; active: boolean } | null;
  contractRewards?: number[];
  /** corp economics, measured: profit/s, valuation, and the dividends you actually receive per s */
  corp?: { profitPerSec: number; valuation: number; realizedPerSec: number; tribute: number } | null;
}

export interface HashOption {
  name: string;
  target?: string;
  cost: number;
  /** money-equivalent $ */
  value: number;
  perHash: number;
  why: string;
}

/** Every hash option worth considering, best $ per hash first. */
export function valueOptions(v: ValueInput, cfg: HacknetConfig = DEFAULT_HACKNET): HashOption[] {
  const out: HashOption[] = [];
  const add = (name: string, value: number, why: string, target?: string) => {
    const cost = v.costs[name];
    if (!(cost > 0) || !(value > 0)) return;
    out.push({ name, target, cost, value, perHash: value / cost, why });
  };
  const T = Math.max(cfg.minRemainingSec, v.remainingSec);

  add(SELL, 1e6, "$1m");

  const mm = (v.maxMoneyGain ?? 1.02) - 1;
  const sec = v.minSecMult ?? 0.98;
  for (const t of v.targets) {
    if (!(t.ratePerSec > 0)) continue;
    add(MAX_MONEY, t.ratePerSec * mm * T, `+${(mm * 100).toFixed(1)}% of $${short(t.ratePerSec)}/s for ${Math.round(T / 60)}m`, t.host);
    const before = 2.5 * t.reqHack * t.minSecurity + 500;
    const after = 2.5 * t.reqHack * Math.max(1, t.minSecurity * sec) + 500;
    const speedup = before / after - 1;
    if (speedup > 0) add(MIN_SEC, t.ratePerSec * speedup * T, `${(speedup * 100).toFixed(2)}% faster on $${short(t.ratePerSec)}/s`, t.host);
  }

  const bb = v.bladeburner;
  // Seconds saved on Bladeburner only matter if Bladeburner is what finishes the node.
  // BN12.27 telemetry: Daedalus 128 days away at 0.036 rank/s, yet rank was priced at
  // $7.3m/hash (29× selling), which justified $23b of production for $1.3b of hashes.
  if (bb?.active && bb.rankPerSec > 0 && Math.max(0, bb.finalRank - bb.rank) / bb.rankPerSec <= cfg.rankHorizonSec) {
    const gained = Math.min(100, Math.max(0, bb.finalRank - bb.rank));
    const saved = gained / bb.rankPerSec;
    add(BB_RANK, saved * v.incomePerSec * cfg.rankSecondValue, `+${gained} rank = ${Math.round(saved / 60)}m of Bladeburner`);
  }

  // corp funds ($1b per purchase) reach you only as dividends, which are taxed
  // (x^(1 − tribute)): value = $1b × the corp's return (profit / valuation) × your measured
  // dividends per $ of profit × (1 − tribute) for the margin × the horizon × a marginal discount
  const c = v.corp;
  if (c && c.profitPerSec > 0 && c.valuation > 0 && c.realizedPerSec > 0) {
    const perProfit = (c.realizedPerSec / c.profitPerSec) * (1 - c.tribute);
    const value = 1e9 * (c.profitPerSec / c.valuation) * perProfit * cfg.corpHorizonSec * cfg.corpMarginalFactor;
    add(CORP_FUNDS, value, `$1b corp → ~$${short(value)} dividends over ${Math.round(cfg.corpHorizonSec / 3600)}h`);
  }

  const r = v.contractRewards ?? [];
  if (r.length >= 3) add(CONTRACT, r.reduce((a, b) => a + b, 0) / r.length, `avg of ${r.length} rewards`);

  return out.sort((a, b) => b.perHash - a.perHash);
}

export type SpendDecision = { kind: "buy"; option: HashOption } | { kind: "sell"; count: number } | { kind: "save"; option: HashOption } | null;

/** Options worth saving for: beat selling, fit the cache, and are reachable before the run ends. */
export function reachable(o: HashOption, hashes: number, production: number, remainingSec: number): boolean {
  return hashes >= o.cost || (production > 0 && (o.cost - hashes) / production <= remainingSec);
}

/**
 * Buy the best option when affordable; save toward it if it beats selling, fits the cache
 * and can be reached before the run ends; otherwise sell (hashes at capacity are wasted).
 */
export function decideSpend(
  options: HashOption[],
  hashes: number,
  capacity: number,
  production = Infinity,
  remainingSec = Infinity,
): SpendDecision {
  const sell = options.find((o) => o.name === SELL);
  const sellPer = sell?.perHash ?? 0;
  const best = options.find(
    (o) => o.name !== SELL && o.perHash > sellPer && o.cost <= capacity && reachable(o, hashes, production, remainingSec),
  );
  if (best) return hashes >= best.cost ? { kind: "buy", option: best } : { kind: "save", option: best };
  if (sell && hashes >= sell.cost) return { kind: "sell", count: Math.floor(hashes / sell.cost) };
  return null;
}

export interface ServerInfo {
  level: number;
  ram: number;
  cores: number;
  production: number;
}

export interface RamUpgrade {
  kind: "ram" | "server";
  index: number;
  cost: number;
  /** GB added to the hack pool */
  gainGB: number;
}

export interface Upgrade {
  kind: "level" | "ram" | "cores" | "server";
  index: number;
  cost: number;
  /** extra hashes/s */
  gain: number;
  paybackSec: number;
}

/**
 * Best production purchase by payback, or null. `rate(level, ram, cores)` is the formula's
 * hashes/s for a server (mult 1); `costOf` prices each upgrade. Real production is the
 * formula × the player's multiplier, estimated from existing servers.
 */
export function chooseUpgrade(
  servers: ServerInfo[],
  rate: (level: number, ram: number, cores: number) => number,
  costOf: (u: { kind: Upgrade["kind"]; index: number }) => number,
  hashValue: number,
  remainingSec: number,
  budget: number,
  cfg: HacknetConfig = DEFAULT_HACKNET,
  fallbackMult = 1,
): Upgrade | null {
  const mults = servers.map((s) => s.production / Math.max(1e-12, rate(s.level, s.ram, s.cores))).filter((m) => m > 0 && Number.isFinite(m));
  const mult = mults.length ? mults.reduce((a, b) => a + b, 0) / mults.length : fallbackMult;
  const cands: Upgrade[] = [];
  const consider = (kind: Upgrade["kind"], index: number, gain: number) => {
    const cost = costOf({ kind, index });
    if (!(cost > 0) || !Number.isFinite(cost) || cost > budget || !(gain > 0)) return;
    cands.push({ kind, index, cost, gain, paybackSec: cost / (gain * hashValue) });
  };
  servers.forEach((s, i) => {
    const now = rate(s.level, s.ram, s.cores) * mult;
    consider("level", i, rate(s.level + 1, s.ram, s.cores) * mult - now);
    consider("ram", i, rate(s.level, s.ram * 2, s.cores) * mult - now);
    consider("cores", i, rate(s.level, s.ram, s.cores + 1) * mult - now);
  });
  consider("server", servers.length, rate(1, 1, 1) * mult);
  const limit = Math.max(cfg.minRemainingSec, remainingSec) * cfg.paybackFrac;
  const best = cands.filter((c) => c.paybackSec <= limit).sort((a, b) => a.paybackSec - b.paybackSec)[0];
  return best ?? null;
}

/**
 * Best RAM purchase by $/GB for share-only mode: double an existing server (adds `ram` GB)
 * or add a new 1 GB server. Levels and cores do not add share threads, so they are skipped.
 */
export function chooseRamUpgrade(
  servers: ServerInfo[],
  costOf: (u: { kind: Upgrade["kind"]; index: number }) => number,
  budget: number,
): RamUpgrade | null {
  const cands: RamUpgrade[] = [];
  const consider = (kind: RamUpgrade["kind"], index: number, gainGB: number) => {
    const cost = costOf({ kind, index });
    if (!(cost > 0) || !Number.isFinite(cost) || cost > budget || !(gainGB > 0)) return;
    cands.push({ kind, index, cost, gainGB });
  };
  servers.forEach((s, i) => consider("ram", i, s.ram));
  consider("server", servers.length, 1);
  return cands.sort((a, b) => a.cost / a.gainGB - b.cost / b.gainGB)[0] ?? null;
}

/** Median of the last 5 run lengths (ms); fallback when there are fewer than 2. */
export function expectedRunMs(durations: number[], fallbackMs: number): number {
  const d = durations.slice(-5).filter((x) => x > 0);
  if (d.length < 2) return fallbackMs;
  const s = [...d].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function short(x: number): string {
  const units: [number, string][] = [[1e12, "t"], [1e9, "b"], [1e6, "m"], [1e3, "k"]];
  for (const [u, s] of units) if (x >= u) return `${(x / u).toFixed(1)}${s}`;
  return x.toFixed(0);
}
