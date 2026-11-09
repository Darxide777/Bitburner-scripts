// Install timing tests (run against the compiled output: `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { valueRuns, averageRate } from "../dist/lib/plan/runs.js";

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
