// Grafting evaluation tests (run against the compiled output: `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseGraft, DEFAULT_GRAFTING, ENTROPY_EFFECT, entropyCost, evaluateGrafts, CONGRUITY } from "../dist/lib/plan/grafting.js";
import { DEFAULT_PLAN } from "../dist/lib/plan/factions.js";

const W = DEFAULT_PLAN.weights;
const row = (over = {}) => ({
  aug: "A",
  price: 1e9,
  hours: 1,
  value: 2,
  net: 1,
  netPerHour: 1,
  entropyCost: entropyCost(W),
  entropyAfter: 1,
  factionEtaH: null,
  faster: true,
  ...over,
});
const ctx = { money: 1e12, installPlanned: false };
const cfg = { ...DEFAULT_GRAFTING, moneyReserve: 0 };

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
  const stackCost = entropyCost(W);
  const oneMore = stackCost * ENTROPY_EFFECT ** 10;
  assert.ok(Math.abs(by.Big.net - (by.Big.value - oneMore)) < 1e-12);
  assert.ok(by.Tiny.net < 0, "a weak aug isn't worth an entropy stack");
  assert.equal(by.Big.faster, true, "only route");
  assert.equal(by.Slow.faster, false, "the faction gets it in a minute");
  assert.ok(by[CONGRUITY].net > 9 * stackCost, "removing 10 stacks");
  assert.equal(by.Big.entropyAfter, 11);
  assert.equal(by.Big.entropyCost, oneMore);
  assert.equal(by[CONGRUITY].entropyAfter, 0);
  assert.equal(by[CONGRUITY].entropyCost, 0);
  assert.equal(rows[0].aug, CONGRUITY);
  // with Congruity owned, grafts cost no entropy
  const free = evaluateGrafts([{ aug: "Tiny", price: 1, timeMs: 3600e3, stats: { charisma: 1.01 }, factionEtaSec: null }], W, { hasCongruity: true });
  assert.ok(free[0].net > 0);
  assert.equal(free[0].entropyAfter, 0);
  assert.equal(free[0].entropyCost, 0);
});

test("chooseGraft picks the best row that clears every cap", () => {
  const pick = chooseGraft([row({ aug: "Low", netPerHour: 1 }), row({ aug: "High", netPerHour: 2 })], cfg, ctx);
  assert.equal(pick.aug, "High");
});

test("chooseGraft enforces the cumulative entropy cap (Congruity is the reset)", () => {
  const capped = { ...cfg, maxEntropy: 1 };
  assert.equal(chooseGraft([row({ aug: "TooMuch", entropyAfter: 2 })], capped, ctx), null);
  assert.equal(chooseGraft([row({ aug: CONGRUITY, entropyAfter: 0 })], capped, ctx).aug, CONGRUITY);
});

test("chooseGraft always skips ready-now routes; slower routes need onlyIfFaster off", () => {
  const ready = row({ aug: "Ready", factionEtaH: 0, faster: false });
  assert.equal(chooseGraft([ready], { ...cfg, onlyIfFaster: false }, ctx), null);
  const slower = row({ aug: "Slower", factionEtaH: 3, faster: false });
  assert.equal(chooseGraft([slower], cfg, ctx), null);
  assert.equal(chooseGraft([slower], { ...cfg, onlyIfFaster: false }, ctx).aug, "Slower");
});

test("chooseGraft enforces net, time, cash reserve, install, and ownership", () => {
  assert.equal(chooseGraft([row({ net: 0.05 })], cfg, ctx), null);
  assert.equal(chooseGraft([row({ netPerHour: 0.01 })], cfg, ctx), null);
  assert.equal(chooseGraft([row({ hours: 13 })], cfg, ctx), null);
  assert.equal(chooseGraft([row({ price: 100 })], { ...cfg, moneyReserve: 10 }, { money: 100, installPlanned: false }), null);
  assert.equal(chooseGraft([row({ price: 90 })], { ...cfg, moneyReserve: 10 }, { money: 100, installPlanned: false }).aug, "A");
  assert.equal(chooseGraft([row()], cfg, { ...ctx, installPlanned: true }), null);
  assert.equal(chooseGraft([row({ aug: "Owned" })], cfg, { ...ctx, owned: ["Owned"] }), null);
  assert.equal(chooseGraft([row({ aug: "Queued" })], cfg, { ...ctx, queued: ["Queued"] }), null);
});

test("chooseGraft never grafts The Red Pill or NeuroFlux", () => {
  assert.equal(chooseGraft([row({ aug: "The Red Pill" })], cfg, ctx), null);
  assert.equal(chooseGraft([row({ aug: "NeuroFlux Governor" })], cfg, ctx), null);
  const noSkips = { ...cfg, skip: [] };
  assert.equal(chooseGraft([row({ aug: "The Red Pill" })], noSkips, ctx), null);
  assert.equal(chooseGraft([row({ aug: "NeuroFlux Governor" })], noSkips, ctx), null);
});
