// Bladeburner decision tests (run against the compiled output: `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseAction, pickSkill, DEFAULT_BB } from "../dist/lib/plan/bladeburner.js";

const act = (type, name, o = {}) => ({ type, name, chance: [0.9, 0.9], count: 100, time: 10_000, rankGain: 1, ...o });
const state = (o = {}) => ({
  stamina: [100, 100],
  chaos: 0,
  rank: 1000,
  resting: false,
  nextBlackOp: null,
  actions: [
    act("Contracts", "Tracking", { rankGain: 0.3, time: 5000 }),
    act("Contracts", "Retirement", { rankGain: 1, time: 5000 }),
    act("Operations", "Assassination", { rankGain: 50, time: 20_000, chance: [0.5, 0.5] }),
    act("Operations", "Raid", { rankGain: 999, time: 1000 }),
  ],
  ...o,
});
const pick = (o) => chooseAction(state(o)).action.name;

test("best expected rank/s among actions likely enough to succeed; Raid is skipped", () => {
  assert.equal(pick(), "Retirement"); // Assassination below 80%, Raid excluded
  const ops = state().actions.map((a) => (a.name === "Assassination" ? { ...a, chance: [0.85, 0.85] } : a));
  assert.equal(pick({ actions: ops }), "Assassination");
});

test("stamina: rest below the low mark, keep resting until the high mark", () => {
  assert.equal(pick({ stamina: [50, 100] }), "Hyperbolic Regeneration Chamber");
  assert.equal(pick({ stamina: [80, 100], resting: true }), "Hyperbolic Regeneration Chamber");
  assert.equal(pick({ stamina: [80, 100], resting: false }), "Retirement");
  assert.equal(chooseAction(state({ stamina: [96, 100], resting: true })).resting, false);
});

test("chaos → Diplomacy, uncertain estimates → Field Analysis", () => {
  assert.equal(pick({ chaos: DEFAULT_BB.chaosMax + 1 }), "Diplomacy");
  const fuzzy = state().actions.map((a, i) => (i === 0 ? { ...a, chance: [0.5, 0.9] } : a));
  assert.equal(pick({ actions: fuzzy }), "Field Analysis");
});

test("black ops: when ranked and near-certain; the BitNode-ending one unless disabled", () => {
  const bo = (name, chance, reqRank = 500) => ({ ...act("Black Operations", name, { chance: [chance, chance] }), reqRank });
  assert.equal(pick({ nextBlackOp: bo("Operation Typhoon", 0.99) }), "Operation Typhoon");
  assert.equal(pick({ nextBlackOp: bo("Operation Typhoon", 0.9) }), "Retirement");
  assert.equal(pick({ nextBlackOp: bo("Operation Typhoon", 0.99, 5000) }), "Retirement");
  assert.equal(pick({ nextBlackOp: bo("Operation Daedalus", 1) }), "Operation Daedalus");
  const off = chooseAction(state({ nextBlackOp: bo("Operation Daedalus", 1) }), { ...DEFAULT_BB, allowFinalBlackOp: false });
  assert.equal(off.action.name, "Retirement");
});

test("fallbacks: Incite Violence when contracts ran out, else Training", () => {
  const none = state().actions.map((a) => ({ ...a, count: 0 }));
  assert.equal(pick({ actions: none }), "Incite Violence");
  const hopeless = state().actions.map((a) => ({ ...a, chance: [0.1, 0.1] }));
  assert.equal(pick({ actions: hopeless }), "Training");
});

test("pickSkill: best weight per point among affordable, respects caps", () => {
  const w = { A: 2, B: 1, Overclock: 10 };
  assert.equal(pickSkill(10, {}, { A: 4, B: 1, Overclock: 100 }, w), "B"); // 1/1 > 2/4, Overclock unaffordable
  assert.equal(pickSkill(10, {}, { A: 1, B: 1, Overclock: 2 }, w), "Overclock");
  assert.equal(pickSkill(10, { Overclock: 90 }, { A: 1, B: 1, Overclock: 2 }, w), "A"); // capped
  assert.equal(pickSkill(0, {}, { A: 1, B: 1 }, w), null);
});
