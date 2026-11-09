// Grafting evaluation tests (run against the compiled output: `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { entropyCost, evaluateGrafts, CONGRUITY } from "../dist/lib/plan/grafting.js";
import { DEFAULT_PLAN } from "../dist/lib/plan/factions.js";

const W = DEFAULT_PLAN.weights;

test("one entropy stack costs 2% of every weighted gain (and of hacknet cost cuts)", () => {
  const small = { hacking: 1, faction_rep: 2, hacknet_node_purchase_cost: 1, untouched_by_entropy: 9 };
  // gains: (1 + 2) × 0.02; cost: 1 × (1/0.98 − 1)
  assert.ok(Math.abs(entropyCost(small) - (3 * 0.02 + (1 / 0.98 - 1))) < 1e-12);
  assert.ok(entropyCost(W) > 0);
});

test("rows: value minus entropy per hour, faction route compared, Congruity credited", () => {
  const rows = evaluateGrafts(
    [
      { aug: "Big", price: 1e9, timeMs: 3600e3, stats: { hacking: 1.5 }, factionEtaSec: null },
      { aug: "Slow", price: 1e9, timeMs: 10 * 3600e3, stats: { hacking: 1.5 }, factionEtaSec: 60 },
      { aug: "Tiny", price: 1, timeMs: 3600e3, stats: { charisma: 1.01 }, factionEtaSec: null },
      { aug: CONGRUITY, price: 1e12, timeMs: 3600e3, stats: {}, factionEtaSec: null },
    ],
    W,
    { hasCongruity: false, entropy: 10 },
  );
  const by = Object.fromEntries(rows.map((r) => [r.aug, r]));
  assert.ok(Math.abs(by.Big.net - (by.Big.value - entropyCost(W))) < 1e-12);
  assert.ok(by.Tiny.net < 0, "a weak aug isn't worth an entropy stack");
  assert.equal(by.Big.faster, true, "only route");
  assert.equal(by.Slow.faster, false, "the faction gets it in a minute");
  assert.ok(by[CONGRUITY].net > 9 * entropyCost(W), "removing 10 stacks");
  assert.equal(rows[0].aug, CONGRUITY);
  // with Congruity owned, grafts cost no entropy
  const free = evaluateGrafts([{ aug: "Tiny", price: 1, timeMs: 3600e3, stats: { charisma: 1.01 }, factionEtaSec: null }], W, { hasCongruity: true });
  assert.ok(free[0].net > 0);
});
