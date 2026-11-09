// Planner unit tests (run against the compiled output: `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, escalatedCost, purchaseOrder, augValue, bestNfgFaction, DEFAULT_PLAN } from "../dist/lib/plan/factions.js";

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
