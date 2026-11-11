// Hacknet decision tests (run against the compiled output: `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { valueOptions, decideSpend, chooseUpgrade, chooseRamUpgrade, expectedRunMs, SELL, MAX_MONEY, MIN_SEC, BB_RANK, CONTRACT, CORP_FUNDS, DEFAULT_HACKNET } from "../dist/lib/plan/hacknet.js";

const costs = { [SELL]: 4, [MAX_MONEY]: 50, [MIN_SEC]: 50, [BB_RANK]: 250, [CONTRACT]: 200 };
const base = (o = {}) => ({ remainingSec: 1800, incomePerSec: 1e7, targets: [], costs, ...o });

test("selling is the floor: $250k per hash", () => {
  const o = valueOptions(base());
  assert.deepEqual(o.map((x) => x.name), [SELL]);
  assert.equal(o[0].perHash, 250_000);
  assert.deepEqual(decideSpend(o, 10, 100), { kind: "sell", count: 2 });
  assert.equal(decideSpend(o, 3, 100), null);
});

test("max money on a rich target beats selling; on a poor one it doesn't", () => {
  const rich = valueOptions(base({ targets: [{ host: "rich", ratePerSec: 1e8, minSecurity: 1, reqHack: 1000 }] }));
  const mm = rich.find((x) => x.name === MAX_MONEY);
  // 2% of $100m/s for 30 min = $3.6b over 50 hashes
  assert.equal(Math.round(mm.value), Math.round(1e8 * 0.02 * 1800));
  assert.equal(rich[0].name, MAX_MONEY);
  assert.deepEqual(decideSpend(rich, 60, 100).kind, "buy");
  assert.deepEqual(decideSpend(rich, 20, 100).kind, "save"); // worth saving for
  assert.equal(decideSpend(rich, 20, 40).kind, "sell"); // doesn't fit the cache → sell
  const poor = valueOptions(base({ targets: [{ host: "poor", ratePerSec: 100, minSecurity: 5, reqHack: 10 }] }));
  assert.equal(poor[0].name, SELL);
  // the measured gain replaces the 2% default
  const measured = valueOptions(base({ maxMoneyGain: 1.01, targets: [{ host: "rich", ratePerSec: 1e8, minSecurity: 1, reqHack: 1000 }] }));
  assert.equal(Math.round(measured.find((x) => x.name === MAX_MONEY).value), Math.round(1e8 * 0.01 * 1800));
});

test("min security: worth less once the floor (1) is reached", () => {
  const hi = valueOptions(base({ targets: [{ host: "a", ratePerSec: 1e8, minSecurity: 30, reqHack: 1000 }] })).find((x) => x.name === MIN_SEC);
  const lo = valueOptions(base({ targets: [{ host: "a", ratePerSec: 1e8, minSecurity: 1, reqHack: 1000 }] })).find((x) => x.name === MIN_SEC);
  assert.ok(hi.value > 0);
  assert.equal(lo, undefined, "already at the floor: no speedup");
});

test("Bladeburner rank: valued by progress saved, capped at what's left", () => {
  const slow = valueOptions(base({ bladeburner: { active: true, rank: 10, rankPerSec: 0.01, finalRank: 400_000 } })).find((x) => x.name === BB_RANK);
  assert.equal(Math.round(slow.value), Math.round((100 / 0.01) * 1e7)); // 10,000 s × $10m/s
  const nearlyDone = valueOptions(base({ bladeburner: { active: true, rank: 399_990, rankPerSec: 0.01, finalRank: 400_000 } })).find((x) => x.name === BB_RANK);
  assert.equal(Math.round(nearlyDone.value), Math.round((10 / 0.01) * 1e7));
  assert.equal(valueOptions(base({ bladeburner: { active: false, rank: 0, rankPerSec: 1, finalRank: 1 } })).find((x) => x.name === BB_RANK), undefined);
});

test("contracts need >= 3 measured rewards", () => {
  assert.equal(valueOptions(base({ contractRewards: [1e9, 1e9] })).find((x) => x.name === CONTRACT), undefined);
  assert.equal(valueOptions(base({ contractRewards: [1e8, 2e8, 3e8] })).find((x) => x.name === CONTRACT).value, 2e8);
});

test("production: best payback within half the run left, within budget", () => {
  const rate = (level, ram, cores) => level * Math.log2(ram + 1) * (1 + cores / 10); // toy formula
  const servers = [{ level: 10, ram: 1, cores: 1, production: rate(10, 1, 1) * 2 }]; // player mult 2
  const costOf = ({ kind }) => ({ level: 1e6, ram: 5e7, cores: 1e9, server: 1e7 })[kind];
  const u = chooseUpgrade(servers, rate, costOf, 250_000, 3600, 1e12);
  // level: +1 level ≈ +2.2 h/s for $1m → payback ≈ 1.8 s: the best
  assert.equal(u.kind, "level");
  assert.ok(Math.abs(u.gain - (rate(11, 1, 1) - rate(10, 1, 1)) * 2) < 1e-9, "uses the measured multiplier");
  assert.equal(chooseUpgrade(servers, rate, costOf, 250_000, 3600, 5e5), null, "over budget");
  assert.equal(chooseUpgrade(servers, rate, () => 1e15, 250_000, 3600, 1e18), null, "never pays back");
});

test("share RAM mode buys GB per dollar: RAM upgrades or new servers", () => {
  const servers = [{ level: 10, ram: 4, cores: 1, production: 0 }];
  const costs = (ram, server) => ({ kind }) => (kind === "ram" ? ram : kind === "server" ? server : Infinity);
  // doubling 4 → 8 GB for $8m beats a new 1 GB server for $10m
  assert.deepEqual(chooseRamUpgrade(servers, costs(8e6, 1e7), 1e12), { kind: "ram", index: 0, cost: 8e6, gainGB: 4 });
  // a cheap new server wins when RAM is expensive
  assert.equal(chooseRamUpgrade(servers, costs(8e8, 1e6), 1e12).kind, "server");
  assert.equal(chooseRamUpgrade(servers, costs(8e6, 1e6), 1e5), null, "over budget");
});

test("expected run length: median of the last 5 runs", () => {
  assert.equal(expectedRunMs([9e8, 24, 28, 20, 19, 18, 133].map((m) => m * 60_000), 1), 20 * 60_000);
  assert.equal(expectedRunMs([5], 777), 777);
});

test("doesn't save for an option it can't reach before the run ends", () => {
  const o = valueOptions(base({ bladeburner: { active: true, rank: 10, rankPerSec: 0.01, finalRank: 400_000 } }));
  assert.equal(o[0].name, BB_RANK);
  assert.equal(decideSpend(o, 10, 1000, 0.001, 1800).kind, "sell", "250 hashes at 0.001/s = 69 h");
  assert.equal(decideSpend(o, 10, 1000, 1, 1800).kind, "save", "240 s away");
  assert.equal(decideSpend(o, 300, 1000, 0, 0).kind, "buy", "already affordable");
});

test("corp funds: valued by the dividends you actually get; today's corp loses to selling", () => {
  const c = { ...costs, [CORP_FUNDS]: 100 };
  // measured today: $0.8m/s profit, $40.9b valuation, ~$514/s reaching the player, tribute 0.5
  const today = valueOptions(base({ costs: c, corp: { profitPerSec: 8e5, valuation: 4.09e10, realizedPerSec: 514, tribute: 0.5 } }));
  const cf = today.find((x) => x.name === CORP_FUNDS);
  assert.ok(cf.perHash < 250_000, `corp funds ${cf.perHash}/hash should lose to selling`);
  assert.equal(today[0].name, SELL);
  // a corp that converts profit to dividends well would win
  const good = valueOptions(base({ costs: c, corp: { profitPerSec: 1e9, valuation: 1e12, realizedPerSec: 5e8, tribute: 0 } }));
  assert.equal(good[0].name, CORP_FUNDS);
  // unprofitable or paying nothing: not an option
  assert.equal(valueOptions(base({ costs: c, corp: { profitPerSec: -1, valuation: 1e12, realizedPerSec: 0, tribute: 0 } })).find((x) => x.name === CORP_FUNDS), undefined);
});
