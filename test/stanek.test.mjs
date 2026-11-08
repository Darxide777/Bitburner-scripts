import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cells, neighbors, fullAt, solveLayout, scoreLayout, giftSize, fragmentEffect, coreBonus, BOOSTER } from "../dist/lib/plan/stanek.js";

const defs = JSON.parse(readFileSync(new URL("./fixtures/fragments.json", import.meta.url)));
const byId = new Map(defs.map((d) => [d.id, d]));
const T = byId.get(5); // T shape: [[X,X,X],[_,X,_]]

test("rotations match the game's fullAt (T-piece, all 4 rotations)", () => {
  // rotation 0: as defined
  assert.deepEqual(cells(T, 0), [[0, 0], [1, 0], [2, 0], [1, 1]]);
  // rotation 1/3 swap width and height; every rotation keeps 4 cells
  for (const r of [0, 1, 2, 3]) assert.equal(cells(T, r).length, 4);
  assert.equal(fullAt(T, 0, 2, 1), false);
  // rotation 2 is upside-down: stem on top
  assert.deepEqual(cells(T, 2), [[1, 0], [0, 1], [1, 1], [2, 1]]);
});

test("neighbors are the empty cells around the shape", () => {
  const O = byId.get(21); // 2x2
  assert.equal(neighbors(O, 0).length, 8);
  assert.ok(neighbors(O, 0).every(([x, y]) => !fullAt(O, x, y, 0)));
});

test("grid size follows the game's formula", () => {
  assert.deepEqual(giftSize(0), { width: 5, height: 5 });
  assert.deepEqual(giftSize(3), { width: 7, height: 6 });
});

test("charge math: more threads help logarithmically; core bonus", () => {
  const a = fragmentEffect(1e4, 5, 1, 1) - 1;
  const b = fragmentEffect(1e8, 5, 1, 1) - 1;
  assert.ok(b > a && b < a * 2.1, "10,000× the threads is only ~2× the bonus");
  assert.equal(coreBonus(1), 1);
  assert.equal(coreBonus(17), 2);
});

test("booster adjacency multiplies a fragment's score", () => {
  const W = 7, H = 6;
  const rep = { id: 25, x: 0, y: 0, rotation: 0 }; // J: (0,0),(0,1),(1,1),(2,1)
  const alone = scoreLayout(defs, W, H, [rep]);
  // booster 101 ([[X,X,X,X],[X,_,_,_]]) placed directly below the J → touches it
  const withBooster = scoreLayout(defs, W, H, [rep, { id: 101, x: 0, y: 2, rotation: 0 }]);
  assert.ok(Math.abs(withBooster / alone - 1.1) < 1e-9);
});

function assertValid(placements, W, H) {
  const seen = new Set();
  const counts = new Map();
  for (const p of placements) {
    const d = byId.get(p.id);
    counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
    assert.ok(counts.get(p.id) <= d.limit, `limit exceeded for ${p.id}`);
    for (const [cx, cy] of cells(d, p.rotation)) {
      const x = p.x + cx, y = p.y + cy;
      assert.ok(x >= 0 && y >= 0 && x < W && y < H, `out of bounds ${p.id}`);
      assert.ok(!seen.has(`${x},${y}`), `overlap at ${x},${y}`);
      seen.add(`${x},${y}`);
    }
  }
}

test("solver: valid layouts that beat 'stat fragments only', deterministic", () => {
  for (const sf of [0, 3]) {
    const { width: W, height: H } = giftSize(sf);
    const r = solveLayout(defs, W, H, undefined, { iterations: 8000, restarts: 6 });
    assertValid(r.placements, W, H);
    assert.ok(r.placements.some((p) => byId.get(p.id).type === 14), "places the Rep fragment");
    // on 5x5, six stat pieces fill 24/25 cells and beat any layout that makes room for a
    // booster (11.9 vs 10.56), so boosters are only expected on bigger grids
    if (W * H >= 42) {
      assert.ok(r.placements.some((p) => byId.get(p.id).type === BOOSTER), "uses boosters");
      const statsOnly = r.placements.filter((p) => byId.get(p.id).type !== BOOSTER);
      assert.ok(r.score > scoreLayout(defs, W, H, statsOnly), "boosters add value");
    }
    const again = solveLayout(defs, W, H, undefined, { iterations: 8000, restarts: 6 });
    assert.equal(again.score, r.score);
  }
});

test("solver respects weights (zero-weight types are left out)", () => {
  const r = solveLayout(defs, 7, 6, { 14: 1 }, { iterations: 4000, restarts: 3 });
  assert.ok(r.placements.every((p) => [14, BOOSTER].includes(byId.get(p.id).type)));
});
