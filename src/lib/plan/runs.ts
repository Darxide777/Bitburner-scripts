// Run history → value rate, for install timing. Pure logic → 0 GB.
//
// Install timing follows the marginal value theorem: keep a run going while waiting for the
// next augs earns value faster than runs do on average (setup ramp included), install once
// it doesn't. A run's value is the planner's aug value of everything that install bought
// (its event in data/events.txt lists the augs and NeuroFlux levels), its length comes from
// data/runs.txt.

export interface RunRecord {
  /** when the run ended (install / reset seen) */
  t: number;
  durationMs: number;
  /** value of what its install bought, stored with the record (newer runs) */
  value?: number;
  /** upgrade/install runs are comparable; a node record summarizes the whole node */
  kind?: "install" | "node";
  node?: number;
  /** totals logged with newer runs, for the per-run comparison */
  earnedTotal?: number;
  incomePerSec?: number;
  hackExpPerSec?: number;
  valueRate?: number;
}

export interface RunStats {
  durationMs: number;
  earnedTotal?: number;
  incomePerSec?: number;
  hackExpPerSec?: number;
  valueRate?: number;
}

export interface RunComparison {
  durationPct: number | null;
  earnedPct: number | null;
  incomePct: number | null;
  hackExpPct: number | null;
  valueRatePct: number | null;
}

const pctChange = (cur?: number, prev?: number): number | null =>
  cur != null && prev != null && Number.isFinite(cur) && Number.isFinite(prev) && prev > 0 ? (cur - prev) / prev : null;

/**
 * Percent change from the previous comparable run (negative duration = faster).
 * Missing fields stay null, so older records still compare duration.
 */
export function compareRun(cur: RunStats, prev?: RunStats | null): RunComparison | null {
  if (!prev || !(prev.durationMs > 0)) return null;
  return {
    durationPct: pctChange(cur.durationMs, prev.durationMs),
    earnedPct: pctChange(cur.earnedTotal, prev.earnedTotal),
    incomePct: pctChange(cur.incomePerSec, prev.incomePerSec),
    hackExpPct: pctChange(cur.hackExpPerSec, prev.hackExpPerSec),
    valueRatePct: pctChange(cur.valueRate, prev.valueRate),
  };
}

export interface InstallRecord {
  t: number;
  bought: string[];
  nfg: number;
}

export interface RunValue {
  end: number;
  durationSec: number;
  value: number;
  /** value per second of the run */
  rate: number;
}

/**
 * Pair each run with the install event that ended it (the latest one inside the run, or just
 * after its recorded end) and value it. Runs without a matching event are skipped.
 */
export function valueRuns(runs: RunRecord[], installs: InstallRecord[], valueOf: (aug: string) => number, nfgValue: number): RunValue[] {
  const out: RunValue[] = [];
  for (const r of runs) {
    if (!(r.durationMs > 0)) continue;
    if (typeof r.value === "number") {
      const durationSec = r.durationMs / 1000;
      out.push({ end: r.t, durationSec, value: r.value, rate: r.value / durationSec });
      continue;
    }
    const ev = installs
      .filter((i) => i.t <= r.t + 60_000 && i.t >= r.t - r.durationMs)
      .sort((a, b) => b.t - a.t)[0];
    if (!ev) continue;
    const value = ev.bought.reduce((a, aug) => a + valueOf(aug), 0) + ev.nfg * nfgValue;
    const durationSec = r.durationMs / 1000;
    out.push({ end: r.t, durationSec, value, rate: value / durationSec });
  }
  return out.sort((a, b) => a.end - b.end);
}

/**
 * Average value rate of the last `n` valued runs (total value ÷ total time, so long runs
 * weigh more), or null with fewer than `min` of them.
 */
export function averageRate(rs: RunValue[], n = 5, min = 3): number | null {
  const recent = rs.slice(-n);
  if (recent.length < min) return null;
  const time = recent.reduce((a, r) => a + r.durationSec, 0);
  return time > 0 ? recent.reduce((a, r) => a + r.value, 0) / time : null;
}

/**
 * A counter that restarts from zero whenever its writer does (a manager's in-memory
 * totals): `total` keeps the sum across restarts, `seen` is the writer's last value.
 */
export interface Tally {
  total: Record<string, number>;
  seen: Record<string, number>;
}

export function tally(prev: Tally | undefined, now: Record<string, number> | undefined): Tally {
  const out: Tally = { total: { ...prev?.total }, seen: { ...prev?.seen } };
  if (!now) return out;
  for (const [k, v] of Object.entries(now)) {
    const before = out.seen[k] ?? 0;
    // a smaller value means the writer restarted: everything it shows is new
    out.total[k] = (out.total[k] ?? 0) + (v >= before ? v - before : v);
    out.seen[k] = v;
  }
  // keys the writer no longer reports: it restarted and hasn't bought those again yet
  for (const k of Object.keys(out.seen)) if (!(k in now)) out.seen[k] = 0;
  return out;
}
