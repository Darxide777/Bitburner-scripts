// IPvGO manager: plays games forever with our own MCTS player, choosing the opponent and
// board size that raise the most valuable bonus fastest (lib/plan/go.ts).
// Steered by data/go-config.txt; status in data/go.txt.
import type { GoOpponent, NS } from "@ns";
import { Board, key, parse } from "../lib/go/engine.js";
import { PASS, search } from "../lib/go/mcts.js";
import { readJson, writeJson } from "../lib/io.js";
import { DATA } from "../lib/paths.js";
import { armKey, chooseArm, DEFAULT_GO, record, type ArmStats, type GoConfig } from "../lib/plan/go.js";

interface GoState {
  arms: Record<string, ArmStats>;
  /** lastAugReset the arm stats belong to (bonuses reset on install) */
  resetMark: number;
  games: number;
}

const ARMS_FILE = "data/go-arms.txt";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const go = ns.go;
  const resetMark = ns.getResetInfo().lastAugReset;
  let st = readJson<GoState>(ns, ARMS_FILE, { arms: {}, resetMark, games: 0 });
  // after an install every bonus restarts from zero: old gain estimates are stale
  if (st.resetMark !== resetMark) st = { arms: {}, resetMark, games: 0 };
  const unavailable = new Set<string>();

  while (true) {
    const cfg: GoConfig = { ...DEFAULT_GO, ...readJson<Partial<GoConfig>>(ns, DATA.goConfig, {}) };
    if (!cfg.enabled) {
      await ns.sleep(30_000);
      continue;
    }

    // ---- pick the next matchup (or finish a game already in progress) ----
    let opponent = go.getOpponent() as string;
    let size = go.getBoardState().length;
    const inProgress = go.getCurrentPlayer() !== "None" && go.getMoveHistory().length > 0;
    if (!inProgress) {
      const known = Object.keys(go.analysis.getStats()).filter((o) => !unavailable.has(o));
      const opponents = [...new Set([...known, ...Object.keys(cfg.weights)])].filter((o) => !unavailable.has(o) && o !== "No AI");
      ({ opponent, size } = chooseArm(st.arms, opponents, cfg));
      try {
        go.resetBoardState(opponent as GoOpponent, size as 5 | 7 | 9 | 13);
      } catch {
        unavailable.add(opponent); // e.g. ???????????? before The Red Pill
        continue;
      }
    }

    // ---- play it out ----
    const before = go.analysis.getStats()[opponent as GoOpponent]?.bonusPercent ?? 0;
    const started = Date.now();
    let opponentPassed = false;
    const thinkMs = cfg.timeMs[String(size)] ?? 400;
    for (let turn = 0; turn < size * size * 4; turn++) {
      const state = go.getGameState();
      if (state.currentPlayer === "None") break;
      if (state.currentPlayer === "White") {
        const r = await go.opponentNextTurn();
        opponentPassed = r.type === "pass";
        if (r.type === "gameOver") break;
        continue;
      }
      const board = new Board(size, parse(go.getBoardState()));
      const history = new Set(go.getMoveHistory().map((cols) => key(parse(cols))));
      const res = await search(board, {
        komi: state.komi,
        timeMs: thinkMs,
        history,
        opponentPassed,
        yieldFn: () => ns.sleep(0),
      });
      let r: { type: "move" | "pass" | "gameOver" };
      try {
        r =
          res.move === PASS
            ? await go.passTurn()
            : await go.makeMove(Math.floor(res.move / size), res.move % size);
      } catch (e) {
        // our engine and the game disagree about legality: log it and pass this turn
        ns.print(`move rejected (${e}); passing`);
        r = await go.passTurn();
      }
      if (r.type === "gameOver") break;
      opponentPassed = r.type === "pass";
    }

    // ---- learn from the result ----
    const end = go.getGameState();
    const after = go.analysis.getStats()[opponent as GoOpponent];
    const won = end.blackScore >= end.whiteScore;
    const gain = (after?.bonusPercent ?? before) - before;
    const ms = Date.now() - started;
    record(st.arms, armKey(opponent, size), won, gain, ms, `${end.blackScore}–${end.whiteScore}`, cfg.alpha);
    st.games++;
    writeJson(ns, ARMS_FILE, st);
    writeJson(ns, DATA.go, {
      t: Date.now(),
      last: { opponent, size, won, score: `${end.blackScore}–${end.whiteScore}`, gainPct: gain, ms },
      games: st.games,
      arms: st.arms,
      bonuses: Object.fromEntries(
        Object.entries(go.analysis.getStats()).map(([o, s]) => [o, { bonusPercent: s?.bonusPercent, wins: s?.wins, losses: s?.losses, winStreak: s?.winStreak }]),
      ),
    });
    ns.print(`${won ? "WIN " : "loss"} vs ${opponent} ${size}x${size}  ${end.blackScore}–${end.whiteScore}  +${gain.toFixed(2)}pp  ${(ms / 1000).toFixed(0)}s`);
  }
}
