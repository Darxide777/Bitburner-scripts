// Corporation decision tests (run against the compiled output: `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { optimalBoost, splitJobs, offerPlateaued, cheapest, DEFAULT_CORP, JOBS } from "../dist/lib/plan/corp.js";

// Agriculture's factors and the materials' sizes
const AGRI = [
  { name: "Hardware", factor: 0.2, size: 0.06 },
  { name: "Robots", factor: 0.3, size: 0.5 },
  { name: "AI Cores", factor: 0.3, size: 0.1 },
  { name: "Real Estate", factor: 0.72, size: 0.005 },
];
const mult = (q) => AGRI.reduce((p, m) => p * (1 + 0.002 * (q[m.name] ?? 0)) ** m.factor, 1);

test("boost mix fills the space and beats every small reallocation", () => {
  for (const space of [100, 1000, 30000]) {
    const q = optimalBoost(AGRI, space);
    const used = AGRI.reduce((a, m) => a + m.size * q[m.name], 0);
    assert.ok(used <= space + 1e-6 && used > space * 0.98, `space ${space}: used ${used}`);
    assert.ok(AGRI.every((m) => q[m.name] >= 0));
    const best = mult(q);
    // move 1% of the space from one material to another: never better
    for (const a of AGRI)
      for (const b of AGRI) {
        if (a === b || q[a.name] <= 0) continue;
        const moved = Math.min(q[a.name], (space * 0.01) / a.size);
        const alt = { ...q, [a.name]: q[a.name] - moved, [b.name]: q[b.name] + (moved * a.size) / b.size };
        assert.ok(mult(alt) <= best * (1 + 1e-9), `space ${space}: ${a.name}→${b.name} improved`);
      }
  }
  // tiny warehouse: expensive-per-space materials drop out instead of going negative
  const small = optimalBoost(AGRI, 5);
  assert.ok(Object.values(small).every((x) => x >= 0));
  assert.equal(small.Robots, 0);
});

test("job split: sums to n, everyone in a job once there are enough people", () => {
  for (const n of [0, 3, 5, 9, 30, 61]) {
    const s = splitJobs(n, DEFAULT_CORP.jobs);
    assert.equal(JOBS.reduce((a, j) => a + s[j], 0), n);
    if (n >= JOBS.length) assert.ok(JOBS.every((j) => s[j] >= 1), `n=${n}`);
  }
  assert.deepEqual(splitJobs(20, DEFAULT_CORP.jobs), { Operations: 5, Engineer: 5, Business: 3, Management: 4, "Research & Development": 3 });
});

test("investment offers: accept once growth stalls over the window", () => {
  const cfg = { ...DEFAULT_CORP, plateauCycles: 3, plateauGrowth: 0.01 };
  assert.equal(offerPlateaued([1, 2, 3], cfg), false, "too few samples");
  assert.equal(offerPlateaued([100, 120, 140, 160], cfg), false, "still growing");
  assert.equal(offerPlateaued([100, 160, 160.5, 161, 161.2], cfg), true);
});

test("cheapest affordable purchase", () => {
  const o = [{ what: "a", cost: 5 }, { what: "b", cost: 2 }, { what: "c", cost: Infinity }, { what: "d", cost: 50 }];
  assert.equal(cheapest(o, 10).what, "b");
  assert.equal(cheapest(o, 1), null);
});
