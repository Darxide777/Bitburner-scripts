import { test } from "node:test";
import assert from "node:assert/strict";
import { Board, BLACK, WHITE, EMPTY, parse, toCols, key, legalMoves } from "../dist/lib/go/engine.js";
import { search, PASS } from "../dist/lib/go/mcts.js";
import { chooseArm, record, armKey, armValue, rotateArm, DEFAULT_GO } from "../dist/lib/plan/go.js";

// boards are column strings like the game: cols[x][y]
const at = (N, x, y) => x * N + y;

test("parse/toCols round-trip, including offline nodes", () => {
  const cols = ["XO.#.", ".....", "..X..", ".....", "#...O"];
  assert.deepEqual(toCols(parse(cols), 5), cols);
});

test("captures remove the chain; suicide is illegal", () => {
  // white stone at (1,1) surrounded on 3 sides by black; black plays the 4th
  const b = new Board(5, parse([".....", ".XO..", "..X..", ".....", "....."].map((c) => c)));
  // place black at (0,1)? set up explicitly instead:
  const c = new Board(5);
  c.cells[at(5, 1, 1)] = WHITE;
  c.cells[at(5, 0, 1)] = BLACK;
  c.cells[at(5, 2, 1)] = BLACK;
  c.cells[at(5, 1, 0)] = BLACK;
  assert.equal(c.play(at(5, 1, 2), BLACK), 1);
  assert.equal(c.cells[at(5, 1, 1)], EMPTY);
  // now white playing back into (1,1) is suicide (no liberties, captures nothing)
  assert.equal(c.play(at(5, 1, 1), WHITE), -1);
  void b;
});

test("superko: recreating an earlier board is not a legal move", () => {
  // classic ko on a 5x5
  const k = new Board(5);
  const put = (x, y, col) => (k.cells[at(5, x, y)] = col);
  put(1, 0, BLACK); put(0, 1, BLACK); put(1, 2, BLACK);
  put(2, 0, WHITE); put(3, 1, WHITE); put(2, 2, WHITE); put(1, 1, WHITE);
  const history = new Set([key(k.cells)]);
  // black captures the white stone at (1,1) by playing (2,1)
  assert.equal(k.play(at(5, 2, 1), BLACK), 1);
  history.add(key(k.cells));
  // white retaking at (1,1) would recreate the first board → illegal
  assert.ok(!legalMoves(k, WHITE, history).includes(at(5, 1, 1)));
});

test("area scoring counts stones + single-color empty regions + komi", () => {
  const b = new Board(5, parse(["X.X..", "XXX..", ".....", "OOOOO", "....."]));
  // black stones 5 + black-only region (0,1) = 1; white stones 5 + region row x=4 (5 cells)
  const s = b.score(5.5);
  assert.equal(s.black, 6);
  assert.equal(s.white, 5 + 5 + 5.5);
});

test("eye detection", () => {
  const b = new Board(5, parse([".X...", "X....", ".....", ".....", "....."]));
  assert.equal(b.isEye(at(5, 0, 0), BLACK), true); // corner eye
  assert.equal(b.isEye(at(5, 0, 0), WHITE), false);
});

test("MCTS kills a big group in atari", async () => {
  // white's 6 stones (x 0-1, y 0-2) have one liberty at (2,2). Two moves win: capture at
  // (2,2), or block at (3,2), after which white playing (2,2) would be suicide.
  const b = new Board(5, parse(["OOOX.", "OOOX.", "XX.X.", ".....", "....."]));
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const r = await search(b, { komi: 5.5, timeMs: 1e9, maxIterations: 3000, rand });
  assert.ok([at(5, 2, 2), at(5, 3, 2)].includes(r.move), `chose ${r.move}`);
  assert.ok(r.winRate > 0.8, `win rate ${r.winRate}`);
});

test("MCTS passes to end a won game after the opponent passes", async () => {
  const b = new Board(5, parse(["X.X.X", "XXXXX", ".....", ".....", "....."]));
  const r = await search(b, { komi: 5.5, timeMs: 1e9, maxIterations: 10, opponentPassed: true });
  assert.equal(r.move, PASS);
});

test("matchup picker: tries valuable untried arms first, then the best value per minute", () => {
  const arms = {};
  const cfg = { ...DEFAULT_GO, sizes: [5, 7], explore: 0 };
  const opps = ["Daedalus", "Netburners"];
  assert.deepEqual(chooseArm(arms, opps, cfg), { opponent: "Daedalus", size: 5 });
  record(arms, armKey("Daedalus", 5), true, 1.0, 60_000, "", 0.3);
  record(arms, armKey("Daedalus", 7), true, 3.0, 60_000, "", 0.3);
  record(arms, armKey("Netburners", 5), true, 5.0, 60_000, "", 0.3);
  record(arms, armKey("Netburners", 7), true, 5.0, 60_000, "", 0.3);
  // Daedalus@7: 4×3 = 12/min beats Netburners: 0.1×5 = 0.5/min
  assert.deepEqual(chooseArm(arms, opps, cfg), { opponent: "Daedalus", size: 7 });
  assert.ok(armValue(arms[armKey("Daedalus", 7)], 4) > armValue(arms[armKey("Netburners", 7)], 0.1));
});

test("rotation: each opponent gets a turn of rotateMs, in weight order, wrapping around", () => {
  const cfg = { ...DEFAULT_GO, weights: { Daedalus: 4, Illuminati: 2, Tetrads: 0.3 }, rotateMs: 15 * 60_000 };
  const opps = ["Tetrads", "Illuminati", "Daedalus"];
  const MIN = 60_000;
  let r = rotateArm({}, opps, cfg, null, 0);
  assert.equal(r.opponent, "Daedalus");
  r = rotateArm({}, opps, cfg, r.rot, 14 * MIN);
  assert.equal(r.opponent, "Daedalus"); // turn not over
  r = rotateArm({}, opps, cfg, r.rot, 15 * MIN);
  assert.deepEqual([r.opponent, r.rot.since], ["Illuminati", 15 * MIN]);
  r = rotateArm({}, opps, cfg, r.rot, 30 * MIN);
  assert.equal(r.opponent, "Tetrads");
  r = rotateArm({}, opps, cfg, r.rot, 45 * MIN);
  assert.equal(r.opponent, "Daedalus"); // wraps
  // an opponent that became unavailable hands over to the next one in the same order
  const gone = rotateArm({}, ["Daedalus", "Tetrads"], cfg, { opponent: "Illuminati", since: 0 }, 1);
  assert.equal(gone.opponent, "Tetrads");
});

test("rotation picks the board size from that opponent's own arms", () => {
  const cfg = { ...DEFAULT_GO, sizes: [5, 7], weights: { A: 1, B: 9 } };
  const arms = {};
  // untried sizes first, smallest first
  assert.equal(rotateArm(arms, ["A"], cfg, null, 0).size, 5);
  record(arms, armKey("A", 5), true, 0.01, 6000, "", 1);
  assert.equal(rotateArm(arms, ["A"], cfg, null, 0).size, 7);
  record(arms, armKey("A", 7), true, 0.2, 12000, "", 1); // 1.0/min vs 0.1/min
  assert.equal(rotateArm(arms, ["A"], { ...cfg, explore: 0 }, null, 0).size, 7);
});
