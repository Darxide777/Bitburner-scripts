// Rate tracking over a rolling window of snapshots. Pure logic → 0 GB.
//
// Every rate is a least-noise "delta over window" (latest minus the oldest sample
// inside the window, divided by elapsed time). Windows are short (1m) for
// reacting and long (10m) for planning; ETAs use the long window when it has
// enough history.
import { GANG_KARMA } from "./paths.js";
import { INCOME_KEYS, type IncomeKey, type Snapshot } from "./types.js";

export interface Rates {
  window: number; // ms actually covered
  income: number; // $/s, all income sources
  bySource: Record<IncomeKey, number>;
  rep: Record<string, number>; // rep/s per faction
  repTotal: number;
  karma: number; // karma/s (negative = toward gang)
  hackExp: number; // xp/s
}

export interface Metrics {
  short: Rates;
  long: Rates;
  /** ms until karma reaches the gang threshold; 0 if in a gang/eligible, ∞ if not progressing. */
  timeToGang: number;
  sinceInstall: number; // ms since last augment install
}

const income = (s: Snapshot) => INCOME_KEYS.reduce((a, k) => a + (s.earned[k] ?? 0), 0);

export class MetricsTracker {
  private samples: Snapshot[] = [];
  private resetMark = 0;

  constructor(private readonly keepMs = 15 * 60_000) {}

  /** Add a snapshot. Clears history if an augment install / node reset happened. */
  push(s: Snapshot): void {
    if (s.lastAugReset !== this.resetMark) {
      this.samples = [];
      this.resetMark = s.lastAugReset;
    }
    this.samples.push(s);
    const cutoff = s.t - this.keepMs;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();
  }

  latest(): Snapshot | undefined {
    return this.samples[this.samples.length - 1];
  }

  rates(windowMs: number): Rates {
    const now = this.latest();
    const empty: Rates = {
      window: 0,
      income: 0,
      bySource: Object.fromEntries(INCOME_KEYS.map((k) => [k, 0])) as Record<IncomeKey, number>,
      rep: {},
      repTotal: 0,
      karma: 0,
      hackExp: 0,
    };
    if (!now) return empty;
    const old = this.samples.find((s) => s.t >= now.t - windowMs) ?? this.samples[0];
    const dt = (now.t - old.t) / 1000;
    if (dt <= 0) return empty;
    const rate = (a: number, b: number) => (a - b) / dt;

    const bySource = Object.fromEntries(
      INCOME_KEYS.map((k) => [k, rate(now.earned[k] ?? 0, old.earned[k] ?? 0)]),
    ) as Record<IncomeKey, number>;
    const rep: Record<string, number> = {};
    let repTotal = 0;
    for (const [f, r] of Object.entries(now.rep)) {
      const v = rate(r, old.rep[f] ?? r); // newly joined faction: no rate yet
      rep[f] = v;
      repTotal += Math.max(0, v);
    }
    return {
      window: dt * 1000,
      income: rate(income(now), income(old)),
      bySource,
      rep,
      repTotal,
      karma: rate(now.karma, old.karma),
      hackExp: rate(now.hackExp, old.hackExp),
    };
  }

  metrics(): Metrics {
    const s = this.latest();
    const short = this.rates(60_000);
    const long = this.rates(10 * 60_000);
    const best = long.window >= 120_000 ? long : short;
    let timeToGang = Infinity;
    if (s) {
      if (s.gang || s.karma <= GANG_KARMA) timeToGang = 0;
      else if (best.karma < 0) timeToGang = ((s.karma - GANG_KARMA) / -best.karma) * 1000;
    }
    return { short, long, timeToGang, sinceInstall: s ? s.t - s.lastAugReset : 0 };
  }

  /** ms until `faction` reaches `target` rep at the current long-window rate. */
  etaRep(faction: string, target: number): number {
    const s = this.latest();
    if (!s) return Infinity;
    const have = s.rep[faction] ?? 0;
    if (have >= target) return 0;
    const m = this.metrics();
    const r = (m.long.window >= 120_000 ? m.long : m.short).rep[faction] ?? 0;
    return r > 0 ? ((target - have) / r) * 1000 : Infinity;
  }

  /** ms until money reaches `target` at the current income rate (ignores spending). */
  etaMoney(target: number): number {
    const s = this.latest();
    if (!s) return Infinity;
    if (s.money >= target) return 0;
    const m = this.metrics();
    const r = (m.long.window >= 120_000 ? m.long : m.short).income;
    return r > 0 ? ((target - s.money) / r) * 1000 : Infinity;
  }
}
