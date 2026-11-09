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

test("pre-4S: estimates follow a simulated forecast, flips go neutral, warm-up stays neutral", async () => {
  const { estimateFromPrices, preForecast, DEFAULT_PRE } = await import("../dist/lib/plan/stocks.js");
  // deterministic pseudo-random walk with a known forecast
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const walk = (start, n, f, vol = 0.02) => {
    const p = [start];
    for (let i = 0; i < n; i++) p.push(p[p.length - 1] * (1 + (rnd() < f ? 1 : -1) * rnd() * vol));
    return p;
  };
  const up = walk(100, 400, 0.7);
  const est = estimateFromPrices(up, 400);
  assert.ok(Math.abs(est.forecast - 0.7) < 0.06, `forecast ${est.forecast}`);
  assert.ok(Math.abs(est.volatility - 0.02) < 0.004, `volatility ${est.volatility}`); // 2 × mean |move|
  // warm-up: too few ticks → neutral and not ready
  const w = preForecast(up.slice(0, 10));
  assert.equal(w.ready, false);
  assert.equal(w.forecast, 0.5);
  // 22 up-ticks then 8 down: long window (20 moves) = 12/20 = 0.6, short (8) = 0 → flip → neutral
  const flip = [100];
  for (let i = 0; i < 22; i++) flip.push(flip[flip.length - 1] * 1.01);
  for (let i = 0; i < 8; i++) flip.push(flip[flip.length - 1] * 0.99);
  assert.ok(Math.abs(estimateFromPrices(flip, DEFAULT_PRE.longWindow).forecast - 0.6) < 1e-9);
  const f = preForecast(flip);
  assert.equal(f.ready, true);
  assert.equal(f.forecast, 0.5, "flip detected");
  // without the down-run it stays a clean up-trend
  assert.equal(preForecast(flip.slice(0, 23)).forecast, 1);
});

test("pre-4S self-analysis: shadow trades, then a verdict on real entries", async () => {
  const { newShadow, shadowStep, preVerdict } = await import("../dist/lib/plan/stocks.js");
  const sh = newShadow();
  // opens at the ask when bullish, closes at the bid when the forecast turns
  shadowStep(sh, [stock("A", { forecast: 0.7, ask: 100, bid: 99 })], 0.1);
  assert.deepEqual(sh.open.A, { side: "L", entry: 100 });
  shadowStep(sh, [stock("A", { forecast: 0.45, ask: 111, bid: 110 })], 0.1);
  assert.ok(Math.abs(sh.returns[0] - 0.1) < 1e-12, "bid 110 / ask 100 − 1");
  assert.equal(sh.open.A, undefined);
  // short side: open at the bid, close at the ask
  shadowStep(sh, [stock("B", { forecast: 0.3, ask: 51, bid: 50 })], 0.1);
  shadowStep(sh, [stock("B", { forecast: 0.6, ask: 40, bid: 39 })], 0.1);
  assert.ok(Math.abs(sh.returns[1] - (50 / 40 - 1)) < 1e-12);

  const cfg = { minTrades: 3, waitFor4sSec: 900 };
  const good = [0.02, 0.03, 0.01];
  assert.equal(preVerdict([0.02], 0.001, [], Infinity, cfg).trade, false, "still learning");
  assert.equal(preVerdict(good, 0.001, [], Infinity, cfg).trade, true);
  assert.equal(preVerdict(good, 0.05, [], Infinity, cfg).trade, false, "fees eat the edge");
  assert.equal(preVerdict([-0.01, -0.02, 0.001], 0, [], Infinity, cfg).trade, false, "losing shadow");
  assert.equal(preVerdict(good, 0.001, [-5, -5, 1], Infinity, cfg).trade, false, "real trades losing → pause");
  assert.equal(preVerdict(good, 0.001, [], 600, cfg).trade, false, "4S in 10 min → wait");
  assert.equal(preVerdict(good, 0.001, [], 0, cfg).trade, false, "4S affordable now");
});
