// Planner unit tests (run against the compiled output: `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, escalatedCost, purchaseOrder, augValue, bestNfgFaction, expToLevel, routeWeights, DEFAULT_PLAN, DAEDALUS_AUGS, DAEDALUS_HACK } from "../dist/lib/plan/factions.js";

const fac = (o = {}) => ({
  joined: false, invited: false, rep: 0, favor: 0, favorGain: 0, enemies: [], workTypes: [],
  bestWork: null, workRepPerSec: 0, augs: [], requirements: [], ...o,
});
const aug = (o = {}) => ({ price: 1e6, repReq: 1e3, prereqs: [], factions: [], stats: {}, ...o });
const CITY_ENEMIES = { "Sector-12": ["Chongqing", "New Tokyo", "Ishima", "Volhaven"], Chongqing: ["Sector-12", "Aevum", "Volhaven"] };

function world(over = {}) {
  return {
    t: 0, money: 2e6, hackLevel: 100, skills: { hacking: 100 }, karma: 0, kills: 0, city: "Sector-12", node: 12,
    sourceFiles: {}, installed: [], queued: [], favorToDonate: 150, repPerDollar: 1e-6, priceMult: 1.9,
    hasNeuroreceptor: false, gangFaction: null, files: ["BruteSSH.exe"], backdoors: {}, backdoorable: ["avmnite-02h"],
    jobs: {}, worldDaemon: { exists: false, rooted: false, reqHack: 0 },
    factions: {
      CyberSec: fac({ joined: true, rep: 5000, workTypes: ["hacking"], bestWork: "hacking", workRepPerSec: 10, augs: ["HackA", "RepB", "NeuroFlux Governor"] }),
      "Sector-12": fac({ invited: true, enemies: CITY_ENEMIES["Sector-12"], augs: ["CashRoot", "NeuroFlux Governor"] }),
      Chongqing: fac({ enemies: CITY_ENEMIES.Chongqing, augs: ["Neuregen"],
        requirements: [{ type: "city", city: "Chongqing" }, { type: "money", money: 20e6 }] }),
      "Tian Di Hui": fac({ augs: ["TDH-Aug"], requirements: [
        { type: "money", money: 1e6 }, { type: "skills", skills: { hacking: 50 } },
        { type: "someCondition", conditions: [{ type: "city", city: "Chongqing" }, { type: "city", city: "New Tokyo" }] },
      ] }),
      NiteSec: fac({ augs: ["NiteAug"], requirements: [{ type: "backdoorInstalled", server: "avmnite-02h" }] }),
    },
    augs: {
      HackA: aug({ repReq: 10_000, price: 1e6, factions: ["CyberSec"], stats: { hacking: 1.05 } }),
      RepB: aug({ repReq: 2_000, price: 5e5, factions: ["CyberSec"], stats: { faction_rep: 1.1 } }),
      CashRoot: aug({ repReq: 12_500, price: 1.25e5, factions: ["Sector-12"] }),
      Neuregen: aug({ factions: ["Chongqing"], stats: { hacking_exp: 1.4 } }),
      "TDH-Aug": aug({ factions: ["Tian Di Hui"], stats: { faction_rep: 1.2 } }),
      NiteAug: aug({ factions: ["NiteSec"], stats: { hacking: 1.1 } }),
      "NeuroFlux Governor": aug({ factions: ["CyberSec", "Sector-12"], stats: { hacking: 1.01 } }),
    },
    ...over,
  };
}
const input = (data, o = {}) => ({ data, observedRep: {}, income: 1e4, sinceInstall: 30 * 60_000, ...o });

test("escalated cost buys most expensive first", () => {
  assert.equal(escalatedCost([1, 10], 2), 10 + 1 * 2);
  assert.equal(escalatedCost([10, 1], 2), 12);
});

test("aug value weights rep and hacking, never zero", () => {
  assert.ok(augValue({ faction_rep: 1.1 }, DEFAULT_PLAN.weights) > augValue({ hacking: 1.05 }, DEFAULT_PLAN.weights));
  assert.ok(augValue({}, DEFAULT_PLAN.weights) > 0);
});

test("BN12 route weights favor income/XP before Daedalus, then rep", () => {
  const w = world();
  const base = DEFAULT_PLAN.weights;
  const pre = routeWeights(w, base);
  assert.ok(pre.hacking_money > base.hacking_money);
  assert.ok(pre.hacking_exp > base.hacking_exp);
  assert.equal(pre.faction_rep, base.faction_rep);

  w.factions.Daedalus = fac({ joined: true });
  const post = routeWeights(w, base);
  assert.ok(post.faction_rep > base.faction_rep);
  assert.equal(post.hacking_money, base.hacking_money);

  w.installed = ["The Red Pill"];
  assert.equal(routeWeights(w, base), base, "post-Red-Pill uses the configured weights");

  const other = world({ node: 1 });
  assert.equal(routeWeights(other, base), base, "other BitNodes are unchanged");
});

test("BN12 route weights change which augs the planner values", () => {
  const w = world({ money: 1e12, installed: ["HackA", "RepB"] });
  w.factions.CyberSec.augs.push("MoneyAug", "RepAug");
  w.augs.MoneyAug = aug({ repReq: 0, price: 1e6, factions: ["CyberSec"], stats: { hacking_money: 3 } });
  w.augs.RepAug = aug({ repReq: 0, price: 1e6, factions: ["CyberSec"], stats: { faction_rep: 1.5 } });
  const value = (p, name) => p.ready.find((c) => c.aug === name)?.value ?? 0;

  const pre = plan(input(w));
  assert.ok(value(pre, "MoneyAug") > value(pre, "RepAug"), "income matters before Daedalus");

  w.factions.Daedalus = fac({ joined: true });
  const post = plan(input(w));
  assert.ok(value(post, "RepAug") > value(post, "MoneyAug"), "rep matters after joining Daedalus");
});

test("BN12 shares the whole pool once money is done and rep is the bottleneck", () => {
  const w = world({ money: 1e12 });
  w.factions.Daedalus = fac({ joined: true });
  const p = plan(input(w, { income: 1e6 }));
  assert.equal(p.moneyBound, false);
  assert.equal(p.repBound, true);
  assert.equal(p.shareAll, true);
  assert.ok(p.augReserve > 0 && p.augReserve < 1e12);
  assert.equal(p.infraSpend, 1);
  assert.equal(p.infraBudget, w.money - p.augReserve);
});

test("share-all waits for cash to cover every wanted aug at once", () => {
  const w = world({ money: 1.5e6 });
  w.factions = {
    Daedalus: fac({ joined: true, workTypes: ["hacking"], bestWork: "hacking", workRepPerSec: 10 }),
    CyberSec: fac({ joined: true, workTypes: ["hacking"], bestWork: "hacking", workRepPerSec: 10, augs: ["A", "B"] }),
  };
  w.augs = {
    A: aug({ price: 1e6, factions: ["CyberSec"] }),
    B: aug({ price: 1e6, factions: ["CyberSec"] }),
  };
  const p = plan(input(w));
  assert.equal(p.moneyBound, false, "each aug fits on its own");
  assert.equal(p.augReserve, 2.9e6, "but not both with 1.9× escalation");
  assert.equal(p.repBound, true);
  assert.equal(p.shareAll, false);
});

test("an unaffordable aug keeps BN12 share-all off", () => {
  const w = world({ money: 1 });
  w.factions.Daedalus = fac({ joined: true });
  const p = plan(input(w));
  assert.equal(p.moneyBound, true);
  assert.equal(p.repBound, false);
  assert.equal(p.shareAll, false);
});

test("share-all is limited to the BN12 Red Pill route", () => {
  const w = world({ node: 1, money: 1e12 });
  w.factions.Daedalus = fac({ joined: true });
  assert.equal(plan(input(w, { income: 1e6 })).shareAll, false);
});

test("does not join a city faction worth less than its enemies", () => {
  const p = plan(input(world()));
  assert.ok(!p.join.includes("Sector-12"), `joined: ${p.join}`);
});

test("joins a city faction worth more than its enemies", () => {
  const w = world();
  w.augs.CashRoot.stats = { faction_rep: 1.5 };
  assert.ok(plan(input(w)).join.includes("Sector-12"));
});

test("works for the faction that gates the next valuable aug", () => {
  const p = plan(input(world()));
  assert.deepEqual(p.work, { faction: "CyberSec", type: "hacking", focus: true });
});

test("rep-ready, affordable augs are 'ready'; rep-gated ones are pending", () => {
  const p = plan(input(world()));
  assert.deepEqual(p.ready.map((c) => c.aug), ["RepB"]);
  assert.ok(p.pending.some((c) => c.aug === "HackA" && c.repGap === 5000));
});

test("travels when a city is the only missing requirement", () => {
  const p = plan(input(world()));
  assert.equal(p.travelTo, "Chongqing");
});

test("backdoors a server that gates a wanted faction", () => {
  assert.deepEqual(plan(input(world())).backdoor, ["avmnite-02h"]);
});

test("no install with too few augs and short wait", () => {
  assert.equal(plan(input(world())).install, null);
});

test("installs when the next aug is far away relative to run time", () => {
  const w = world({ money: 1e12 });
  for (const n of ["A1", "A2", "A3", "A4"]) {
    w.augs[n] = aug({ repReq: 0, price: 1e6, factions: ["CyberSec"], stats: { hacking: 1.02 } });
    w.factions.CyberSec.augs.push(n);
  }
  w.augs.HackA.repReq = 1e9; // ~27 hours of work away
  const p = plan(input(w, { sinceInstall: 60 * 60_000 }));
  assert.ok(p.install, "expected an install");
  assert.match(p.install.reason, /next aug/);
  // purchase order: most expensive first
  const prices = p.install.buy.map(([, a]) => w.augs[a].price);
  assert.deepEqual(prices, [...prices].sort((a, b) => b - a));
});

test("prerequisites are bought before dependents even if cheaper", () => {
  const w = world();
  w.augs.Big = aug({ price: 1e9, prereqs: ["Small"] });
  w.augs.Small = aug({ price: 1 });
  assert.deepEqual(purchaseOrder(["Big", "Small"], w), ["Small", "Big"]);
});

test("donation covers the rep gap when favor allows", () => {
  const w = world({ money: 1e12 });
  w.factions.CyberSec.favor = 200;
  const p = plan(input(w));
  const hack = p.ready.find((c) => c.aug === "HackA");
  assert.ok(hack && hack.donation > 0, "HackA should be bought via donation");
});

test("never works for or plans around Shadows of Anarchy", () => {
  const w = world();
  w.factions["Shadows of Anarchy"] = fac({ joined: true, rep: 1e9, augs: ["SoA"] });
  w.augs.SoA = aug({ repReq: 0, factions: ["Shadows of Anarchy"], stats: { faction_rep: 3 } });
  const p = plan(input(w));
  assert.ok(!p.ready.some((c) => c.aug === "SoA"));
});

test("destroys w0r1d_d43m0n when ready", () => {
  const w = world({ installed: ["The Red Pill"], hackLevel: 5000, worldDaemon: { exists: true, rooted: true, reqHack: 3000 } });
  assert.equal(plan(input(w)).destroy, true);
});

test("grindFactions/repGated are complete even when pending is truncated to gang augs", () => {
  const w = world();
  w.gangFaction = "Tetrads";
  w.factions.Tetrads = fac({ joined: true, rep: 0, augs: [] });
  for (let i = 0; i < 10; i++) {
    w.augs[`T${i}`] = aug({ repReq: 1e9, factions: ["Tetrads"], stats: { faction_rep: 2 } }); // very valuable, gang-gated
    w.factions.Tetrads.augs.push(`T${i}`);
  }
  // gang respect produces Tetrads rep fast, so its (valuable) augs top the truncated display list
  w.augs.HackA.repReq = 1e12;
  w.augs.RepB.repReq = 1e12;
  const p = plan(input(w, { observedRep: { Tetrads: 1e6 } }));
  assert.ok(p.pending.slice(0, 8).every((c) => c.faction === "Tetrads"), "display list is all gang augs");
  assert.deepEqual(p.grindFactions, ["CyberSec"]);
  assert.equal(p.repGated.Tetrads, 10);
  assert.match(p.notes.join(" "), /CyberSec/);
});

test("favorFactions: joined workable factions nobody grinds, closest to donations first", () => {
  const w = world();
  w.factions.A = fac({ joined: true, workTypes: ["hacking"], bestWork: "hacking", favor: 140, favorGain: 20 });
  w.factions.B = fac({ joined: true, workTypes: ["hacking"], bestWork: "hacking", favor: 10, favorGain: 5 });
  w.factions.C = fac({ joined: true, workTypes: ["hacking"], bestWork: "hacking", favor: 300 }); // already donates
  const p = plan(input(w));
  assert.ok(!p.favorFactions.includes("CyberSec"), "CyberSec is a grind target, not a favor target");
  assert.deepEqual(p.favorFactions.filter((f) => ["A", "B", "C"].includes(f)), ["A", "B", "C"]);
});

test("NeuroFlux grind picks the fastest rep/s faction and doesn't hop on rep changes", () => {
  const nfg = (rep, rate) =>
    fac({ joined: true, rep, workTypes: ["security"], bestWork: "security", workRepPerSec: rate, augs: ["NeuroFlux Governor"] });
  const data = (reps) =>
    world({
      factions: {
        A: nfg(reps[0], 90), // >10% slower than C
        B: nfg(reps[1], 105), // within 10% of the fastest, C
        C: nfg(reps[2], 110),
        D: fac({ joined: true, rep: 9e9, augs: ["NeuroFlux Governor"] }), // not workable
      },
    });
  // fresh pick: fastest, not the one with the most rep
  assert.equal(bestNfgFaction(data([3e6, 3.1e6, 2e6]), true), "C");
  // rep leadership flipping back and forth (sleeves) never moves the player
  for (const reps of [[3.5e6, 3.4e6, 3.3e6], [3.3e6, 3.5e6, 3.4e6], [3.4e6, 3.3e6, 3.5e6]])
    assert.equal(bestNfgFaction(data(reps), true, "B"), "B");
  // ...but a clearly faster faction (>10%) wins over the current one
  assert.equal(bestNfgFaction(data([1, 1, 1]), true, "A"), "C");
  // current faction no longer eligible → best
  assert.equal(bestNfgFaction(data([1, 1, 1]), true, "D"), "C");
});

function bladeWorld() {
  const w = world({ installed: ["HackA", "RepB"], money: 1e15 }); // nothing left to grind at CyberSec
  w.factions.Bladeburners = fac({ joined: true, favor: 500, augs: ["BB-Aug"] }); // no work types
  w.augs["BB-Aug"] = aug({ repReq: 1e5, price: 1e6, factions: ["Bladeburners"], stats: { hacking: 1.05 } });
  return w;
}

test("Bladeburners rep is never planned as a donation, even with donation favor", () => {
  const p = plan(input(bladeWorld()));
  const c = [...p.ready, ...p.pending].find((x) => x.aug === "BB-Aug");
  assert.ok(c, "BB-Aug is a candidate");
  assert.equal(c.donation, 0);
  assert.ok(!(p.install?.donate ?? []).some(([f]) => f === "Bladeburners"));
});

test("idle player goes to Bladeburner (before NeuroFlux) only without the Simulacrum", () => {
  const w = bladeWorld();
  const idle = plan(input(w, { bladeburner: { inDivision: true, simulacrum: false } }));
  assert.equal(idle.bladeburner, true);
  assert.equal(idle.work, null);
  assert.equal(idle.crime, null);
  // with the Simulacrum both run: NeuroFlux work + Bladeburner
  const both = plan(input(w, { bladeburner: { inDivision: true, simulacrum: true } }));
  assert.equal(both.bladeburner, true);
  assert.equal(both.work?.faction, "CyberSec");
  // not in the division: unchanged behavior
  const none = plan(input(w));
  assert.equal(none.bladeburner, false);
  assert.equal(none.work?.faction, "CyberSec");
});

test("Bladeburner first: train combat stats one at a time before grinding, only once joining is safe", () => {
  const w = world({ skills: { hacking: 100, strength: 150, defense: 40, dexterity: 120, agility: 90 } });
  // order is fixed (str → def → dex → agi), not "lowest first", so near-equal stats don't hop
  const even = world({ skills: { hacking: 100, strength: 7, defense: 6, dexterity: 6, agility: 6 } });
  assert.equal(plan(input(even, { bladeburner: { inDivision: false, simulacrum: false, canJoin: true } })).train?.stat, "str");
  const p = plan(input(w, { bladeburner: { inDivision: false, simulacrum: false, canJoin: true } }));
  assert.deepEqual(p.train && [p.train.stat, p.train.gym], ["def", "Powerhouse Gym"]);
  assert.equal(p.work, null);
  assert.equal(p.travelTo, null);
  // Stanek not settled yet → no training, normal grind
  const wait = plan(input(w, { bladeburner: { inDivision: false, simulacrum: false, canJoin: false } }));
  assert.equal(wait.train, null);
  assert.equal(wait.work?.faction, "CyberSec");
  // stats reached / already joined / disabled → no training
  const strong = world({ skills: { hacking: 100, strength: 100, defense: 100, dexterity: 100, agility: 100 } });
  assert.equal(plan(input(strong, { bladeburner: { inDivision: false, simulacrum: false, canJoin: true } })).train, null);
  assert.equal(plan(input(w, { bladeburner: { inDivision: true, simulacrum: true, canJoin: true } })).train, null);
  assert.equal(plan(input(w, { bladeburner: { inDivision: false, simulacrum: false, canJoin: true } }), { ...DEFAULT_PLAN, bladeburnerFirst: false }).train, null);
});

test("Church of the Machine God: no donations (it offers no work); its augs get the configured bonus", () => {
  const w = world({ money: 1e15 });
  w.factions["Church of the Machine God"] = fac({ joined: true, favor: 500, augs: ["Stanek's Gift - Awakening"] });
  w.augs["Stanek's Gift - Awakening"] = aug({ repReq: 1.6e6, price: 0, factions: ["Church of the Machine God"], stats: { hacking: 1.01 } });
  const p = plan(input(w));
  const c = [...p.ready, ...p.pending].find((x) => x.aug === "Stanek's Gift - Awakening");
  assert.ok(c);
  assert.equal(c.donation, 0, "never planned as a donation");
  const plain = plan(input(w), { ...DEFAULT_PLAN, augBonus: {} });
  const c0 = [...plain.ready, ...plain.pending].find((x) => x.aug === "Stanek's Gift - Awakening");
  assert.ok(c.value > c0.value + 2.9, `${c.value} vs ${c0.value}`);
  assert.ok((p.repGated["Church of the Machine God"] ?? 0) > 0, "rep-gated → the daemon adds chargers");
});

test("no ETA-based install before observed rates exist (right after a daemon restart)", () => {
  const w = world({ money: 1e15, installed: ["HackA", "RepB"] }); // nothing grindable left
  // a valuable aug whose rep only has an observed rate (no work types), plus enough ready augs
  w.factions.Church = fac({ joined: true, augs: ["Awake"] });
  w.augs.Awake = aug({ repReq: 1e9, factions: ["Church"], stats: { hacking: 1.5 } });
  for (let i = 0; i < 6; i++) {
    w.augs[`R${i}`] = aug({ repReq: 1, price: 1e3, factions: ["CyberSec"], stats: { hacking: 1.01 } });
    w.factions.CyberSec.augs.push(`R${i}`);
  }
  const later = { sinceInstall: 3 * 3600_000 - 1 };
  assert.ok(plan(input(w, later)).install, "with rates: next aug ∞ away → install");
  assert.equal(plan(input(w, { ...later, ratesReady: false })).install, null, "no rates yet → wait");
});

function megaWorld(companyRate) {
  const w = world({ money: 1e15 });
  w.factions.ECorp = fac({ augs: ["ECorp Aug"], requirements: [{ type: "companyReputation", company: "ECorp", reputation: 400_000 }] });
  w.augs["ECorp Aug"] = aug({ repReq: 1000, price: 1e6, factions: ["ECorp"], stats: { hacking: 3 } }); // very valuable
  w.companies = { ECorp: { rep: 0, favor: 0, job: null, position: "Software Engineering Intern", field: "Software", repPerSec: companyRate } };
  return w;
}

test("company work: taken when its route beats the best faction grind, skipped otherwise", () => {
  // fast company rep: 400k at 2000/s = 200 s, then 1000 rep at ~10/s → beats CyberSec's HackA
  const fast = plan(input(megaWorld(2000)));
  assert.equal(fast.company?.company, "ECorp");
  assert.equal(fast.company?.field, "Software");
  assert.equal(fast.work, null);
  assert.equal(fast.companyRoutes[0].faction, "ECorp");
  assert.ok(fast.companyRoutes[0].score > fast.grindScore * 1.2);
  // slow company rep (400k at 1/s ≈ 4.6 days): keep grinding the faction
  const slow = plan(input(megaWorld(1)));
  assert.equal(slow.company, null);
  assert.equal(slow.work?.faction, "CyberSec");
  assert.ok(slow.companyRoutes.length === 1, "still logged for comparison");
  // disabled
  assert.equal(plan(input(megaWorld(2000)), { ...DEFAULT_PLAN, companyWork: false }).company, null);
});

test("company rep counts toward invites once earned", () => {
  const w = megaWorld(2000);
  w.companies.ECorp.rep = 400_000;
  const p = plan(input(w));
  assert.equal(p.company, null, "requirement met: nothing left to earn there");
  assert.equal(p.companyRoutes.length, 0);
});

test("expToLevel inverts the game's skill formula with a calibrated multiplier", () => {
  // the game: skill = floor(m·(32·ln(exp + 534.6) − 200))
  const skill = (exp, m) => m * (32 * Math.log(exp + 534.6) - 200);
  for (const m of [0.5, 1, 2.7]) {
    const exp0 = 5e5;
    const lvl0 = skill(exp0, m);
    const need = expToLevel(lvl0 * 1.5, lvl0, exp0);
    assert.ok(Math.abs(skill(exp0 + need, m) - lvl0 * 1.5) < 1e-6, `m=${m}`);
  }
  assert.equal(expToLevel(10, 20, 1e4), 0);
});

function gateWorld(o = {}) {
  const w = world({ money: 1e15, installed: ["HackA", "RepB"], skills: { hacking: 100, charisma: 50 }, exp: { hacking: 1e4, charisma: 2000 } });
  w.study = {
    hacking: { university: "ZB Institute of Technology", city: "Volhaven", course: "Algorithms", expPerSec: 50 },
    charisma: { university: "ZB Institute of Technology", city: "Volhaven", course: "Leadership", expPerSec: 50 },
  };
  w.factions.Charm = fac({ augs: ["Charm Aug"], requirements: [{ type: "skills", skills: { charisma: 60 } }] });
  w.augs["Charm Aug"] = aug({ repReq: 100, price: 1e6, factions: ["Charm"], stats: { hacking: 3 } });
  return Object.assign(w, o);
}

test("skill gates: study charisma for a valuable gated faction; nothing when disabled", () => {
  const p = plan(input(gateWorld()));
  assert.equal(p.skillGates[0].target, "Charm");
  assert.deepEqual(p.skillGates[0].needs, { charisma: 60 });
  assert.equal(p.study?.course, "Leadership");
  assert.equal(p.study?.city, "Volhaven");
  assert.equal(p.work, null);
  assert.equal(p.hackXp, null, "no hacking gate");
  assert.equal(plan(input(gateWorld()), { ...DEFAULT_PLAN, skillWork: false }).study, null);
});

test("w0r1d_d43m0n's hack level turns on XP farming", () => {
  const w = gateWorld({ installed: ["HackA", "RepB", "The Red Pill"], worldDaemon: { exists: true, rooted: true, reqHack: 3000 } });
  const p = plan(input(w));
  assert.deepEqual(p.hackXp, { level: 3000, why: "w0r1d_d43m0n" });
  assert.ok(p.skillGates.some((g) => g.target === "w0r1d_d43m0n"));
});

test("a company job blocked by a skill is a gate; company work alone is no route then", () => {
  const w = gateWorld();
  delete w.factions.Charm;
  w.factions.ECorp = fac({ augs: ["ECorp Aug"], requirements: [{ type: "companyReputation", company: "ECorp", reputation: 1000 }] });
  w.augs["ECorp Aug"] = aug({ repReq: 100, price: 1e6, factions: ["ECorp"], stats: { hacking: 3 } });
  w.companies = { ECorp: { rep: 0, favor: 0, job: null, position: null, field: null, repPerSec: 0, skillGate: { charisma: 75 } } };
  const p = plan(input(w));
  assert.equal(p.companyRoutes.length, 0, "no qualifying job → no company route");
  assert.equal(p.skillGates[0].target, "ECorp job (for ECorp)");
  assert.equal(p.study?.skill, "charisma");
});

test("combat gates train at the best gym, one stat at a time in a fixed order", () => {
  const w = gateWorld({ skills: { hacking: 100, charisma: 100, strength: 50, defense: 20, dexterity: 20, agility: 20 }, exp: { strength: 500, defense: 100, dexterity: 100, agility: 100 } });
  delete w.factions.Charm;
  for (const s of ["strength", "defense", "dexterity", "agility"])
    w.study[s] = { kind: "gym", university: "Powerhouse Gym", city: "Sector-12", course: s.slice(0, 3), expPerSec: 100 };
  w.factions.Tetrads = fac({ augs: ["T Aug"], requirements: [{ type: "skills", skills: { strength: 75, defense: 75, dexterity: 75, agility: 75 } }] });
  w.augs["T Aug"] = aug({ repReq: 100, price: 1e6, factions: ["Tetrads"], stats: { hacking: 3 } });
  const p = plan(input(w));
  assert.ok(Number.isFinite(p.skillGates[0].studySec));
  assert.deepEqual(p.train, { stat: "str", gym: "Powerhouse Gym", city: "Sector-12", focus: true }, "strength first (lowest is defense, but order is fixed)");
  assert.equal(p.study, null);
  w.skills.strength = 80;
  assert.equal(plan(input(w)).train?.stat, "def");
});

function installWorld() {
  // 6 cheap ready augs and one valuable one 1000 rep away at CyberSec (10 rep/s → 100 s)
  const w = world({ money: 1e15, installed: ["HackA", "RepB"] });
  for (let i = 0; i < 6; i++) {
    w.augs[`R${i}`] = aug({ repReq: 1, price: 1e3, factions: ["CyberSec"], stats: { hacking: 1.01 } });
    w.factions.CyberSec.augs.push(`R${i}`);
  }
  w.augs.Big = aug({ repReq: 6000, price: 1e3, factions: ["CyberSec"], stats: { hacking: 1.5 } });
  w.factions.CyberSec.augs.push("Big");
  return w;
}

test("install timing: marginal value of waiting vs. recent runs' average rate", () => {
  const since = { sinceInstall: 3600_000 };
  const p0 = plan(input(installWorld(), { ...since, avgRunRate: 1e-9 }));
  assert.ok(p0.installRates.marginal > 0);
  assert.equal(p0.install, null, "waiting beats a poor history: keep going");
  const p1 = plan(input(installWorld(), { ...since, avgRunRate: 1e3 }));
  assert.ok(p1.install && p1.install.reason.startsWith("waiting earns"), p1.install?.reason);
  // no history: the old patience rule (next aug 100 s away vs 0.5 × 1 h → no install)
  assert.equal(plan(input(installWorld(), { ...since, avgRunRate: null })).install, null);
});

function redPillWorld(over = {}) {
  const w = installWorld();
  while (w.installed.length < DAEDALUS_AUGS) w.installed.push(`Old${w.installed.length}`);
  w.factions.Daedalus = fac();
  return Object.assign(w, over);
}

test("BN12 Red Pill push: hold installs, start Daedalus XP before the money gate", () => {
  const since = { sinceInstall: 3600_000, avgRunRate: 1e3 };
  const w = redPillWorld({ money: 1e6, hackLevel: 1000 });
  w.study = { hacking: { university: "ZB Institute of Technology", city: "Volhaven", course: "Algorithms", expPerSec: 50 } };
  const p = plan(input(w, since));
  assert.equal(p.install, null, "holding the run for The Red Pill");
  assert.equal(p.redPillPush, true);
  assert.equal(p.postRedPill, false);
  assert.deepEqual(p.hackXp, { level: DAEDALUS_HACK, why: "Daedalus" });
  assert.equal(p.study, null, "hacking XP comes from scripts, not a 28-year class");
  assert.ok(p.notes.some((n) => n.includes("holding install")), p.notes.join("; "));
  const off = plan(input(w, since), { ...DEFAULT_PLAN, pushRedPill: false });
  assert.ok(off.install, "opt-out keeps normal install timing");
  const capped = plan(input(w, { sinceInstall: DEFAULT_PLAN.pushRedPillMaxMs + 1, avgRunRate: 1e3 }));
  assert.ok(capped.install, "the safety cap allows an install when the push stalls");
  assert.ok(capped.notes.some((n) => n.includes("cap")), capped.notes.join("; "));
  assert.equal(plan(input(redPillWorld({ money: 1e6, hackLevel: DAEDALUS_HACK }), since)).hackXp, null);
  const done = redPillWorld({ money: 1e15, hackLevel: DAEDALUS_HACK });
  done.installed.push("The Red Pill");
  const after = plan(input(done, since));
  assert.equal(after.install, null, "post-Red-Pill hold: do not reset the w0r1d hack level");
  assert.equal(after.postRedPill, true);
  assert.ok(after.notes.some((n) => n.includes("w0r1d_d43m0n")), after.notes.join("; "));
  assert.ok(plan(input(done, since), { ...DEFAULT_PLAN, autoDestroy: false }).install, "autoDestroy off restores normal installs");
});

test("BN12 Red Pill push: infra budget follows The Red Pill ETA, not the next aug", () => {
  const since = { sinceInstall: 3600_000, avgRunRate: 1e3 };
  const w = redPillWorld({ money: 1e15, hackLevel: 1000 });
  w.factions.Daedalus = fac({
    joined: true, rep: 0, workTypes: ["hacking"], bestWork: "hacking", workRepPerSec: 100, augs: ["The Red Pill"],
  });
  w.augs["The Red Pill"] = aug({ price: 1e9, repReq: 3_600_000, factions: ["Daedalus"], stats: { hacking: 1.5 } });
  const p = plan(input(w, since));
  assert.equal(p.redPillPush, true);
  assert.ok(p.install === null);
  assert.ok(p.infraSpend > 0.2, `spend ${p.infraSpend} should use the 10h Red Pill ETA, not nextEta`);
});

test("BN12 post-Red-Pill: maximize infra spending for the final hack-level grind", () => {
  const since = { sinceInstall: 3600_000, avgRunRate: 1e3 };
  const done = redPillWorld({ money: 1e15, hackLevel: DAEDALUS_HACK });
  done.installed.push("The Red Pill");
  const p = plan(input(done, since));
  assert.equal(p.postRedPill, true);
  assert.equal(p.infraSpend, 0.5);
});

test("no 'unlocks donations' install for factions that take no donations", () => {
  const w = installWorld();
  w.factions.Church = fac({ joined: true, favor: 100, favorGain: 100, augs: ["ChurchAug"] }); // no work types
  w.augs.ChurchAug = aug({ repReq: 1e9, factions: ["Church"], stats: { hacking: 1.2 } });
  const p = plan(input(w, { sinceInstall: 3600_000, avgRunRate: 1e-9 }));
  assert.ok(!p.install || !p.install.reason.includes("donations at Church"), p.install?.reason);
});
