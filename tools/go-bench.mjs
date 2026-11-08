// Offline benchmark: MCTS (black) vs a tactical bot (white) using the compiled engine.
// Usage: node tools/go-bench.mjs [size=7] [games=10] [timeMs=300] [komi=5.5]
import { Board, BLACK, WHITE, EMPTY, key, legalMoves, other } from "../dist/lib/go/engine.js";
import { search, PASS } from "../dist/lib/go/mcts.js";

const [N = 7, games = 10, timeMs = 300, komi = 5.5] = process.argv.slice(2).map(Number);

function botMove(b, color, history) {
  const moves = legalMoves(b, color, history).filter((i) => !b.isEye(i, color));
  if (!moves.length) return PASS;
  // capture first
  const enemy = other(color);
  for (const i of moves) {
    const c = b.clone();
    if (c.play(i, color) > 0) return i;
  }
  // save own chains in atari
  for (let i = 0; i < b.N * b.N; i++)
    if (b.cells[i] === color && b.chain(i, 2) === 1) {
      const lib = b.lastLib;
      if (moves.includes(lib) && !b.selfAtari(lib, color)) return lib;
    }
  const safe = moves.filter((i) => !b.selfAtari(i, color));
  const pool = safe.length ? safe : moves;
  void enemy;
  return pool[Math.floor(Math.random() * pool.length)];
}

let wins = 0;
let totalIters = 0;
let totalMoves = 0;
let blackPts = 0;
for (let g = 0; g < games; g++) {
  const b = new Board(N);
  const history = new Set([key(b.cells)]);
  let color = BLACK;
  let passes = 0;
  let lastWasPass = false;
  for (let m = 0; m < N * N * 4 && passes < 2; m++) {
    let mv;
    if (color === BLACK) {
      const r = await search(b, { komi, timeMs, history, opponentPassed: lastWasPass });
      mv = r.move;
      totalIters += r.iterations;
      totalMoves++;
    } else mv = botMove(b, WHITE, history);
    if (mv === PASS) {
      passes++;
      lastWasPass = true;
    } else {
      if (b.play(mv, color) < 0) throw new Error(`illegal move by ${color === BLACK ? "MCTS" : "bot"}`);
      history.add(key(b.cells));
      passes = 0;
      lastWasPass = false;
    }
    color = other(color);
  }
  const s = b.score(komi);
  if (s.black >= s.white) wins++;
  blackPts += s.black;
  process.stdout.write(`game ${g + 1}: black ${s.black} vs white ${s.white} ${s.black >= s.white ? "WIN" : "loss"}\n`);
}
console.log(`\n${N}x${N} komi ${komi}: MCTS won ${wins}/${games}, avg black points ${(blackPts / games).toFixed(1)}, ~${Math.round(totalIters / totalMoves)} playouts/move at ${timeMs}ms`);
