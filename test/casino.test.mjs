import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldHit } from "../dist/casino.js";

const hard = (best) => ({ best, soft: false });
const soft = (best) => ({ best, soft: true });

test("hard hands: always hit ≤11, always stand ≥17", () => {
  for (const d of [2, 6, 7, 11]) {
    assert.equal(shouldHit(hard(11), d), true);
    assert.equal(shouldHit(hard(17), d), false);
  }
});

test("hard 12: stand only against dealer 4-6", () => {
  assert.deepEqual([2, 3, 4, 5, 6, 7, 10].map((d) => shouldHit(hard(12), d)), [true, true, false, false, false, true, true]);
});

test("hard 13-16: stand against 2-6, hit against 7+", () => {
  for (const v of [13, 16]) {
    assert.equal(shouldHit(hard(v), 6), false);
    assert.equal(shouldHit(hard(v), 7), true);
    assert.equal(shouldHit(hard(v), 11), true);
  }
});

test("soft hands: hit ≤17, soft 18 hits only vs 9/10/A, stand ≥19", () => {
  assert.equal(shouldHit(soft(17), 2), true);
  assert.equal(shouldHit(soft(18), 8), false);
  assert.equal(shouldHit(soft(18), 9), true);
  assert.equal(shouldHit(soft(18), 11), true);
  assert.equal(shouldHit(soft(19), 11), false);
});
