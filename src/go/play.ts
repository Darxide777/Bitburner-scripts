// IPvGO manager: plays games forever with our own MCTS player, choosing the opponent and
// board size that raise the most valuable bonus fastest (lib/plan/go.ts).
// Steered by data/go-config.txt; status in data/go.txt.
import type { GoOpponent, NS } from "@ns";
import { BLACK, Board, EMPTY, key, parse, WHITE } from "../lib/go/engine.js";
import { call } from "../lib/call.js";
import { PASS, search } from "../lib/go/mcts.js";
import { readJson, writeJson } from "../lib/io.js";
import { DATA } from "../lib/paths.js";
import {
  armKey,
  chooseArm,
  chooseCheat,
  DEFAULT_GO,
  record,
  rotateArm,
  type ArmStats,
  type CheatOption,
  type GoConfig,
  type Rotation,
} from "../lib/plan/go.js";

interface GoState {
  arms: Record<string, ArmStats>;
  /** lastAugReset the arm stats belong to (bonuses reset on install) */
  resetMark: number;
  games: number;
  /** rotation mode: current opponent's turn */
  rot?: Rotation | null;
  /** cheats: attempts, successes, ejections, and the summed predicted chance (to check it) */
  cheats?: { attempts: number; successes: number; ejections: number; predicted: number };
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
  /** null = not checked yet; false = no SF14.2 */
  let cheatsAvailable: boolean | null = null;
  /** last cheat check, for the status file: why cheats are (not) being played */
  let cheatCheck = { available: null as boolean | null, chance: 0, evaluated: 0, last: "" };

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
      if (cfg.rotateMs > 0) {
        const prev = st.rot?.opponent;
        const r = rotateArm(st.arms, opponents, cfg, st.rot ?? null, Date.now());
        ({ opponent, size } = r);
        st.rot = r.rot;
        if (prev !== opponent) ns.print(`rotation: ${opponent} for ${Math.round(cfg.rotateMs / 60_000)} min`);
      } else ({ opponent, size } = chooseArm(st.arms, opponents, cfg));
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
      // ---- cheat, if its expected value beats the normal move ----
      if (cfg.cheats && cheatsAvailable !== false && res.move !== PASS) {
        // a proxy that can't start (home RAM full) just means: no cheat this turn
        const p = await call<number>(ns, "go.cheat.getCheatSuccessChance").catch(() => null);
        if (p === null) cheatCheck.last = "no RAM for the cheat proxy this turn";
        else {
        cheatsAvailable = p !== undefined;
        cheatCheck.available = cheatsAvailable;
        cheatCheck.chance = p ?? 0;
        if (p === undefined) cheatCheck.last = "no SF14.2 (getCheatSuccessChance unavailable)";
        else if (p < cfg.cheatMinChance) cheatCheck.last = `chance ${(p * 100).toFixed(0)}% < ${cfg.cheatMinChance * 100}%`;
        else if (res.winRate > cfg.cheatMaxWinRate) cheatCheck.last = `already winning (${res.winRate.toFixed(2)})`;
        if (p !== undefined && p >= cfg.cheatMinChance && res.winRate <= cfg.cheatMaxWinRate) {
          const prior = (await call<number>(ns, "go.cheat.getCheatCount").catch(() => 0)) ?? 0;
          const pick = await evaluateCheats(ns, board, size, state.komi, history, res.move, res.winRate, thinkMs, p, prior, cfg);
          cheatCheck.evaluated++;
          cheatCheck.last = pick ? `played ${pick.kind} (EV ${pick.ev.toFixed(2)} vs ${res.winRate.toFixed(2)})` : `evaluated: no cheat beats ${res.winRate.toFixed(2)} by ${cfg.cheatMargin}`;
          if (pick) {
            const xy = (i: number) => [Math.floor(i / size), i % size];
            const rr = await (pick.kind === "twoMoves"
              ? call<{ type: "move" | "pass" | "gameOver" }>(ns, "go.cheat.playTwoMoves", ...xy(pick.cells[0]), ...xy(pick.cells[1]))
              : call<{ type: "move" | "pass" | "gameOver" }>(ns, "go.cheat.removeRouter", ...xy(pick.cells[0]))
            ).catch(() => "no RAM" as const);
            if (rr === "no RAM") {
              cheatCheck.last = "no RAM for the cheat call: normal move";
            } else {
            const now = parse(go.getBoardState());
            const ok = pick.kind === "twoMoves" ? pick.cells.every((i) => now[i] === BLACK) : now[pick.cells[0]] !== WHITE;
            const c = (st.cheats ??= { attempts: 0, successes: 0, ejections: 0, predicted: 0 });
            c.attempts++;
            c.predicted += p;
            if (ok) c.successes++;
            else if (rr?.type === "gameOver") c.ejections++;
            ns.print(`cheat ${pick.kind} (p ${(p * 100).toFixed(0)}%, EV ${pick.ev.toFixed(2)} vs ${res.winRate.toFixed(2)}): ${ok ? "ok" : "failed"}`);
            if (rr) {
              if (rr.type === "gameOver") break;
              opponentPassed = rr.type === "pass";
              continue;
            }
            // the proxy threw (move rejected?): fall through to a normal move this turn
            }
          }
        }
        }
      }

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
      cheats: st.cheats ?? null,
      cheatCheck,
      rotation: cfg.rotateMs > 0 ? { ...st.rot, endsIn: st.rot ? Math.max(0, st.rot.since + cfg.rotateMs - Date.now()) : 0 } : null,
      arms: st.arms,
      bonuses: Object.fromEntries(
        Object.entries(go.analysis.getStats()).map(([o, s]) => [o, { bonusPercent: s?.bonusPercent, wins: s?.wins, losses: s?.losses, winStreak: s?.winStreak }]),
      ),
    });
    ns.print(`${won ? "WIN " : "loss"} vs ${opponent} ${size}x${size}  ${end.blackScore}–${end.whiteScore}  +${gain.toFixed(2)}pp  ${(ms / 1000).toFixed(0)}s`);
  }
}

/** Swap colors so the search (which always plays black) evaluates the opponent's turn. */
function swapColors(b: Board): Board {
  return new Board(b.N, Int8Array.from(b.cells, (v) => (v === BLACK ? WHITE : v === WHITE ? BLACK : v)));
}

/**
 * Value each cheat with our own search and pick one if its EV beats the normal move
 * (lib/plan/go.ts chooseCheat). Each evaluation gets half the normal thinking time.
 */
async function evaluateCheats(
  ns: NS,
  board: Board,
  size: number,
  komi: number,
  history: Set<string>,
  bestMove: number,
  vNormal: number,
  thinkMs: number,
  p: number,
  prior: number,
  cfg: GoConfig,
): Promise<(CheatOption & { ev: number }) | null> {
  const t = Math.max(50, thinkMs / 2);
  const yieldFn = () => ns.sleep(0);
  // the opponent to move = our turn skipped (a failed cheat): 1 − their win rate
  const opp = async (b: Board) => 1 - (await search(swapColors(b), { komi: -komi, timeMs: t, yieldFn })).winRate;
  const vSkip = await opp(board);
  const options: CheatOption[] = [];
  // two moves: our best move, then our best reply to our own position
  const b1 = board.clone();
  b1.play(bestMove, BLACK);
  const r2 = await search(b1, { komi, timeMs: t, history, yieldFn });
  if (r2.move !== PASS) options.push({ kind: "twoMoves", cells: [bestMove, r2.move], value: r2.winRate });
  // remove a router: one stone from each of up to 3 short-of-liberty enemy chains
  const seen = new Set<number>();
  for (let i = 0; i < size * size && options.length < 4; i++) {
    if (board.cells[i] !== WHITE || seen.has(i)) continue;
    const libs = board.chain(i);
    for (let k = 0; k < board.chainLen; k++) seen.add(board.chainStones[k]);
    if (libs > 2) continue;
    const b2 = board.clone();
    b2.cells[i] = EMPTY;
    options.push({ kind: "removeRouter", cells: [i], value: await opp(b2) });
  }
  return chooseCheat(options, p, prior, vNormal, vSkip, cfg);
}
