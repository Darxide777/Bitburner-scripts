// Stock decision tests (run against the compiled output: `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTrades, positionValue, DEFAULT_STOCKS } from "../dist/lib/plan/stocks.js";

const stock = (sym, o = {}) => ({
  sym, forecast: 0.5, volatility: 0.01, ask: 101, bid: 99, maxShares: 1e6,
  long: 0, longAvg: 0, short: 0, shortAvg: 0, ...o,
});
const C = 100e3; // commission

test("opens the best expected return first, long above 0.5 and short below", () => {
  const s = [
    stock("WEAK", { forecast: 0.56, volatility: 0.01 }),
    stock("BULL", { forecast: 0.7, volatility: 0.02 }),
    stock("BEAR", { forecast: 0.3, volatility: 0.015 }),
    stock("FLAT", { forecast: 0.52, volatility: 0.05 }), // inside the enter edge
  ];
  const t = decideTrades(s, 1e12, C);
  assert.deepEqual(t.map((x) => [x.kind, x.sym]), [["buyLong", "BULL"], ["buyShort", "BEAR"], ["buyLong", "WEAK"]]);
  // maxShares caps each position
  assert.ok(t.every((x) => x.shares <= 1e6));
  const noShorts = decideTrades(s, 1e12, C, { ...DEFAULT_STOCKS, allowShorts: false });
  assert.ok(!noShorts.some((x) => x.kind === "buyShort"));
});

test("exits when the forecast turns, and can flip to the other side in the same tick", () => {
  const s = [stock("A", { forecast: 0.4, long: 1000, longAvg: 90 }), stock("B", { forecast: 0.65, short: 500, shortAvg: 110 })];
  const t = decideTrades(s, 1e9, C);
  assert.deepEqual(t.slice(0, 2).map((x) => [x.kind, x.sym, x.shares]), [["sellLong", "A", 1000], ["sellShort", "B", 500]]);
  assert.ok(t.some((x) => x.kind === "buyShort" && x.sym === "A"));
  assert.ok(t.some((x) => x.kind === "buyLong" && x.sym === "B"));
  // still above 0.5 → hold the long (hysteresis between 0.55 entry and 0.5 exit)
  assert.equal(decideTrades([stock("A", { forecast: 0.52, long: 1000, longAvg: 90 })], 0, C).length, 0);
});

test("keeps the cash reserve and skips orders too small to beat the commission", () => {
  const s = [stock("A", { forecast: 0.7, ask: 100 })];
  const [t] = decideTrades(s, 1e9, C, { ...DEFAULT_STOCKS, reserveFrac: 0.5 });
  assert.ok(t.shares * 100 <= 0.5e9 + 1, `spent ${t.shares * 100}`);
  assert.equal(decideTrades(s, 5e6, C).length, 0); // $5m < 100 × commission
});

test("position value: longs at the bid, shorts return stake ± the move", () => {
  assert.equal(positionValue(stock("A", { long: 10, bid: 99 })), 990);
  // shorted at 110, now ask 101: 10 × (110 + (110 − 101))
  assert.equal(positionValue(stock("A", { short: 10, shortAvg: 110, ask: 101 })), 1190);
});
