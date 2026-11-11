// Install timing tests (run against the compiled output: `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { valueRuns, averageRate, compareRun, tally } from "../dist/lib/plan/runs.js";

test("runs are valued by the augs their install bought; average = total value / total time", () => {
  const runs = [
    { t: 1_000_000, durationMs: 600_000 },
    { t: 2_000_000, durationMs: 1_000_000 },
    { t: 3_000_000, durationMs: 400_000 },
    { t: 9_000_000, durationMs: 100_000 }, // no matching install event → skipped
  ];
  const installs = [
    { t: 999_500, bought: ["A", "B"], nfg: 2 },
    { t: 1_999_000, bought: ["C"], nfg: 0 },
    { t: 3_000_400, bought: ["A"], nfg: 1 }, // logged just after the run record: still matches
  ];
  const v = valueRuns(runs, installs, (a) => ({ A: 1, B: 2, C: 4 })[a], 0.1);
  assert.deepEqual(v.map((r) => Math.round(r.value * 10) / 10), [3.2, 4, 1.1]);
  assert.ok(Math.abs(averageRate(v) - (3.2 + 4 + 1.1) / 2000) < 1e-12);
  assert.equal(averageRate(v.slice(0, 2)), null, "fewer than 3 valued runs");
});

test("a run's stored value wins over matching install events", () => {
  const v = valueRuns([{ t: 1000, durationMs: 1000, value: 7 }], [{ t: 999, bought: ["A"], nfg: 0 }], () => 1, 0);
  assert.equal(v[0].value, 7);
});

test("compareRun reports percent changes and skips missing fields", () => {
  const prev = { durationMs: 1000, earnedTotal: 100, incomePerSec: 0.1, hackExpPerSec: 5, valueRate: 0.002 };
  const cur = { durationMs: 800, earnedTotal: 120, incomePerSec: 0.15, hackExpPerSec: 6, valueRate: 0.0025 };
  const c = compareRun(cur, prev);
  assert.ok(c);
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≈ ${expected}`);
  close(c.durationPct, -0.2); // shorter is negative
  close(c.earnedPct, 0.2);
  close(c.incomePct, 0.5);
  close(c.hackExpPct, 0.2);
  close(c.valueRatePct, 0.25);

  const old = compareRun({ durationMs: 500 }, prev);
  assert.ok(old);
  close(old.durationPct, -0.5);
  assert.equal(old.earnedPct, null, "old records still compare duration");
  assert.equal(compareRun(cur, null), null);
  assert.equal(compareRun(cur, { durationMs: 0 }), null);
});

test("tally sums a counter across its writer's restarts", () => {
  let t = tally(undefined, { sell: 3, rank: 1 });
  t = tally(t, { sell: 5, rank: 1 });
  assert.deepEqual(t.total, { sell: 5, rank: 1 });
  // the manager restarted: its totals start over, ours keep growing
  t = tally(t, {});
  t = tally(t, { sell: 2 });
  t = tally(t, { sell: 4, rank: 1 });
  assert.deepEqual(t.total, { sell: 9, rank: 2 });
  // a stale or missing status file changes nothing
  assert.deepEqual(tally(t, undefined).total, t.total);
});
