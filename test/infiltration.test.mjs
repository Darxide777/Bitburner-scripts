// Infiltration decision tests (run against the compiled output: `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextStep, identify, ringMoves, gridPath, chooseTarget, recordRun, estimateRepPerSec, KEYS, DEFAULT_INFILTRATION } from "../dist/lib/plan/infiltration.js";

const keys = (m) => nextStep(m).keys;

test("each game is identified by its fields", () => {
  assert.equal(identify({ code: [], index: 0 }), "cheatcode");
  assert.equal(identify({ phase: 0, distractedTime: 1 }), "slash");
  assert.equal(identify({ left: "", right: "" }), "bracket");
  assert.equal(identify({ grid: [], answers: [] }), "cyberpunk");
  assert.equal(identify({ choices: [], correctIndex: 0 }), "bribe");
  assert.equal(identify({ minefield: [], answer: [] }), "minesweeper");
  assert.equal(identify({ wires: [], wiresToCut: new Set() }), "wirecutting");
  assert.equal(identify({ guess: "", answer: "X" }), "backward");
  assert.equal(identify({ count: 3 }), "countdown");
  assert.equal(identify({}), "unknown");
});

test("simple games: the right next key", () => {
  assert.deepEqual(keys({ code: ["←", "↑", "→"], index: 1 }), [KEYS.up]);
  assert.deepEqual(keys({ left: "[<({", right: "}" }), [")"]); // closes from the inside out
  assert.deepEqual(keys({ wires: [{}, {}, {}], wiresToCut: new Set([0, 2]), cutWires: [true, false, false] }), ["3"]);
  assert.deepEqual(keys({ guess: "ALGO", answer: "ALGORITHM BIT" }), ["R"]);
  assert.deepEqual(keys({ guess: "ALGORITHM", answer: "ALGORITHM BIT" }), [" "]);
});

test("slash only strikes while the guard is distracted (phase 1)", () => {
  assert.equal(nextStep({ phase: 0, distractedTime: 1 }).wait, true);
  assert.deepEqual(keys({ phase: 1, distractedTime: 1 }), [KEYS.space]);
  assert.equal(nextStep({ phase: 2, distractedTime: 1 }).wait, true);
});

test("bribe: shortest way round to the positive word, then space", () => {
  assert.deepEqual(keys({ choices: ["a", "b", "c", "d", "e"], correctIndex: 4, index: 0 }), [KEYS.down, KEYS.space]); // wrap backwards
  assert.deepEqual(keys({ choices: ["a", "b", "c", "d", "e"], correctIndex: 2, index: 0 }), [KEYS.up, KEYS.up, KEYS.space]);
});

test("grid games: wrap-around paths to the nearest target", () => {
  assert.equal(ringMoves(0, 3, 4), -1);
  assert.equal(ringMoves(3, 0, 4), 1);
  assert.deepEqual(gridPath(0, 0, 2, 1, 3, 3), [KEYS.left, KEYS.down]);
  const grid = [["AA", "BB", "CC"], ["DD", "EE", "BB"], ["FF", "GG", "HH"]];
  // two "BB": (1,0) is 1 step right, (2,1) is 1 left + 1 down → the closer one
  assert.deepEqual(keys({ grid, answers: ["BB"], currentAnswerIndex: 0, x: 0, y: 0 }), [KEYS.right, KEYS.space]);
  const mines = [[false, true], [true, false]];
  assert.equal(nextStep({ minefield: mines, answer: [[false, false], [false, false]], memoryPhase: true, x: 0, y: 0 }).wait, true);
  const m = keys({ minefield: mines, answer: [[false, true], [false, false]], memoryPhase: false, x: 1, y: 0 });
  assert.deepEqual(m, [KEYS.right, KEYS.down, KEYS.space]); // (0,1) is a mine, (1,0) already marked
});

test("target choice: below the difficulty cap, best rep/s, measured beats estimated, decay drops it", () => {
  const T = (name, difficulty, levels, tradeRep) => ({ name, city: "Aevum", difficulty, levels, tradeRep, sellCash: 0 });
  const targets = [T("easy", 1, 5, 1500), T("rich", 2.5, 10, 6000), T("deadly", 3.2, 10, 1e9)];
  assert.equal(chooseTarget(targets, {}).target.name, "rich"); // 200/s vs 100/s; deadly excluded
  const measured = { rich: recordRun(undefined, 1000, 100) }; // only 10/s in practice
  assert.equal(chooseTarget(targets, measured).target.name, "easy");
  let decayed = recordRun(undefined, 1000, 10);
  decayed = recordRun(decayed, 400, 10); // below 50% of the first run
  assert.equal(estimateRepPerSec(T("x", 1, 5, 1e9), decayed, DEFAULT_INFILTRATION), 0);
});

test("safety: skip targets whose failures we couldn't survive; drop unreliable ones; back off", async () => {
  const { failureDamage, cooldownAfter, recordFailure } = await import("../dist/lib/plan/infiltration.js");
  const T = (name, sec, tradeRep) => ({ name, city: "Aevum", difficulty: 1, levels: 5, tradeRep, sellCash: 0, startingSecurity: sec });
  const targets = [T("safe", 2, 100), T("risky", 20, 10_000)];
  // risky: 60 HP per failure, 2 failures = 120 > 100 HP → skipped
  assert.equal(failureDamage(20), 60);
  assert.equal(chooseTarget(targets, {}, DEFAULT_INFILTRATION, { current: 100 }).target.name, "safe");
  assert.equal(chooseTarget(targets, {}, DEFAULT_INFILTRATION, { current: 100, harmonizer: true }).target.name, "risky", "halved: 60 < 100");
  assert.equal(chooseTarget(targets, {}, DEFAULT_INFILTRATION, { current: 5 }), null, "nothing survivable");
  // 1 success, 2 failures → 33% < 67% after 3 attempts → dropped
  let m = recordRun(undefined, 1000, 10);
  m = recordFailure(m);
  assert.ok(estimateRepPerSec(T("x", 1, 1), m) > 0, "2 attempts: too early to judge");
  m = recordFailure(m);
  assert.equal(estimateRepPerSec(T("x", 1, 1), m), 0);
  assert.equal(cooldownAfter(0), 0);
  assert.equal(cooldownAfter(1), 10 * 60_000);
  assert.equal(cooldownAfter(3), 40 * 60_000);
  assert.equal(cooldownAfter(10), 2 * 3600_000);
});
