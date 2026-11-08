import { test } from "node:test";
import assert from "node:assert/strict";
import { decideGang, ascendThreshold, DEFAULT_GANG } from "../dist/lib/plan/gang.js";
import { decideSleeves } from "../dist/lib/plan/sleeves.js";

// ---------- gang ----------
const member = (name, stat, o = {}) => ({
  name, task: "Unassigned", earnedRespect: 10, hack: stat, str: stat, def: stat, dex: stat, agi: stat, cha: 1,
  hack_asc_mult: 1, str_asc_mult: 1, def_asc_mult: 1, dex_asc_mult: 1, agi_asc_mult: 1, cha_asc_mult: 1,
  upgrades: [], augmentations: [], ...o,
});
const task = (name, o = {}) => ({ name, isHacking: false, isCombat: true, baseRespect: 0, baseMoney: 0, baseWanted: 0, ...o });
const TASKS = [
  task("Train Combat"),
  task("Vigilante Justice", { baseWanted: -10 }),
  task("Territory Warfare"),
  task("Terrorism", { baseRespect: 10, baseWanted: 5 }),
  task("Human Trafficking", { baseMoney: 10, baseRespect: 1, baseWanted: 2 }),
];
// toy gain model: proportional to stat, uses the task's base numbers
const gain = (m, t) => ({ respect: t.baseRespect * m.str, money: t.baseMoney * m.str, wanted: t.baseWanted * m.str });
const gangInfo = (o = {}) => ({ faction: "Tetrads", isHacking: false, territory: 1, respect: 1e6, wantedPenalty: 1, ...o });
const gin = (o = {}) => ({ gang: gangInfo(), members: [member("a", 500), member("b", 400)], tasks: TASKS, gain, rivals: [], ascension: {}, ...o });

test("respect mode picks the best respect task; money mode the best money task", () => {
  assert.equal(decideGang(gin()).tasks.a, "Terrorism");
  assert.equal(decideGang(gin(), { ...DEFAULT_GANG, mode: "money" }).tasks.a, "Human Trafficking");
});

test("weak members train", () => {
  const d = decideGang(gin({ members: [member("a", 500), member("weak", 10)] }));
  assert.equal(d.tasks.weak, "Train Combat");
});

test("builds territory power and only engages when every clash is likely won", () => {
  const rivals = [{ name: "X", territory: 0.3, chance: 0.4 }];
  const members = ["a", "b", "c", "d"].map((n, i) => member(n, 300 + i * 100));
  let d = decideGang(gin({ gang: gangInfo({ territory: 0.5 }), members, rivals }));
  assert.equal(d.warfare, false);
  assert.equal(d.tasks.d, "Territory Warfare"); // strongest member
  d = decideGang(gin({ gang: gangInfo({ territory: 0.5 }), members, rivals: [{ ...rivals[0], chance: 0.7 }] }));
  assert.equal(d.warfare, true);
});

test("cools down the least valuable worker when the wanted penalty is high", () => {
  const d = decideGang(gin({ gang: gangInfo({ wantedPenalty: 0.8 }) }));
  assert.equal(d.tasks.b, "Vigilante Justice");
  assert.equal(d.tasks.a, "Terrorism");
});

test("ascends the member with the best gain over threshold, one at a time", () => {
  const d = decideGang(gin({ ascension: { a: { str: 2, def: 2, dex: 2, agi: 2 }, b: { str: 1.7, def: 1.7, dex: 1.7, agi: 1.7 } } }));
  assert.deepEqual(d.ascend, ["a"]);
  assert.ok(ascendThreshold(1) > ascendThreshold(100));
});

test("does not ascend below threshold", () => {
  const d = decideGang(gin({ ascension: { a: { str: 1.2, def: 1.2, dex: 1.2, agi: 1.2 } } }));
  assert.deepEqual(d.ascend, []);
});

// ---------- sleeves ----------
const sleeve = (i, o = {}) => ({ i, shock: 0, current: null, homicideChance: 0.9, gains: {}, ...o });

test("sleeves all do crime for karma when there is no gang yet", () => {
  const a = decideSleeves({ sleeves: [sleeve(0), sleeve(1, { homicideChance: 0.2 })], needKarma: true, targets: ["X"], playerFaction: null });
  assert.deepEqual(a, [{ kind: "crime", crime: "Homicide" }, { kind: "crime", crime: "Mug" }]);
});

test("one sleeve per target faction, best sleeve each, never the player's faction", () => {
  const sleeves = [
    sleeve(0, { gains: { A: { hacking: 5 }, B: { field: 1 } } }),
    sleeve(1, { gains: { A: { hacking: 9 }, B: { field: 2, security: 3 } } }),
    sleeve(2, { shock: 50, gains: { A: { hacking: 1 } } }),
  ];
  const a = decideSleeves({ sleeves, needKarma: false, targets: ["P", "A", "B"], playerFaction: "P" });
  assert.deepEqual(a[1], { kind: "faction", faction: "A", type: "hacking" });
  assert.deepEqual(a[0], { kind: "faction", faction: "B", type: "field" });
  assert.deepEqual(a[2], { kind: "recovery" }); // shocked leftover recovers
});
