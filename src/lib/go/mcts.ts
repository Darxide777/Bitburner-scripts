// Monte Carlo tree search player for IPvGO (written from scratch). Pure logic → 0 GB.
//
// UCT search from the root position; each simulation descends the tree, expands one
// move, then finishes the game with a fast "tactical" random playout:
//   1. capture an enemy chain in atari (if any) most of the time
//   2. otherwise a random legal move that neither fills our own eye nor puts our own
//      chain into atari (self-atari)
//   3. pass when nothing is left; two passes end the playout
// The reward is mostly win/loss, plus a little for black's area, since IPvGO node power
// grows with the points we end up with.
import { BLACK, Board, EMPTY, type Color, legalMoves, other } from "./engine.js";

export const PASS = -1;

interface Node {
  move: number; // move that led here (PASS allowed)
  toPlay: Color; // player to move at this node
  parent: Node | null;
  children: Node[];
  untried: number[];
  visits: number;
  /** total reward from the perspective of the player who made `move` */
  value: number;
}

export interface SearchOptions {
  komi: number;
  /** ms of thinking per move */
  timeMs: number;
  /** called every ~sliceMs so the game UI can breathe (e.g. () => ns.sleep(0)) */
  yieldFn?: () => Promise<unknown>;
  sliceMs?: number;
  /** superko history (board keys) */
  history?: Set<string>;
  /** did the opponent just pass? (then passing ends the game) */
  opponentPassed?: boolean;
  rand?: () => number;
  /** reward weight for black's area share (0..1); the rest is win/loss */
  areaWeight?: number;
  maxIterations?: number;
}

export interface SearchResult {
  move: number; // index or PASS
  winRate: number; // estimated for black
  iterations: number;
}

const C = 0.9; // exploration constant

export async function search(root: Board, opts: SearchOptions): Promise<SearchResult> {
  const rand = opts.rand ?? Math.random;
  const history = opts.history ?? new Set<string>();
  const areaWeight = opts.areaWeight ?? 0.1;
  const rootMoves = legalMoves(root, BLACK, history).filter((i) => !root.isEye(i, BLACK));

  // with the opponent having passed, passing ends the game right now: take it if we win
  if (opts.opponentPassed) {
    const s = root.score(opts.komi);
    if (s.black >= s.white) return { move: PASS, winRate: 1, iterations: 0 };
  }
  if (rootMoves.length === 0) return { move: PASS, winRate: 0, iterations: 0 };

  const rootNode: Node = {
    move: PASS,
    toPlay: BLACK,
    parent: null,
    children: [],
    untried: [...rootMoves, PASS],
    visits: 0,
    value: 0,
  };

  const deadline = Date.now() + opts.timeMs;
  const slice = opts.sliceMs ?? 25;
  let iterations = 0;
  const maxIt = opts.maxIterations ?? Infinity;
  while (Date.now() < deadline && iterations < maxIt) {
    const sliceEnd = Math.min(deadline, Date.now() + slice);
    while (Date.now() < sliceEnd && iterations < maxIt) {
      simulate(root, rootNode, opts.komi, rand, areaWeight, opts.opponentPassed ?? false);
      iterations++;
    }
    if (opts.yieldFn) await opts.yieldFn();
  }

  // most-visited child
  let best = rootNode.children[0];
  for (const c of rootNode.children) if (c.visits > best.visits) best = c;
  const winRate = best && best.visits ? best.value / best.visits : 0;
  return { move: best ? best.move : PASS, winRate, iterations };
}

function simulate(root: Board, rootNode: Node, komi: number, rand: () => number, areaWeight: number, rootOppPassed: boolean) {
  const b = root.clone();
  let node = rootNode;
  // consecutive passes along the path (the opponent's pass before the root counts)
  let passes = rootOppPassed ? 1 : 0;

  // selection
  while (node.untried.length === 0 && node.children.length > 0) {
    node = select(node);
    if (node.move === PASS) passes++;
    else {
      b.play(node.move, other(node.toPlay));
      passes = 0;
    }
    if (passes >= 2) break;
  }

  // expansion
  if (passes < 2 && node.untried.length > 0) {
    const k = Math.floor(rand() * node.untried.length);
    const move = node.untried[k];
    node.untried[k] = node.untried[node.untried.length - 1];
    node.untried.pop();
    const mover = node.toPlay;
    let ok = true;
    if (move === PASS) passes++;
    else {
      ok = b.play(move, mover) >= 0;
      passes = 0;
    }
    if (ok) {
      const child: Node = {
        move,
        toPlay: other(mover),
        parent: node,
        children: [],
        untried: passes >= 2 ? [] : candidateMoves(b, other(mover)),
        visits: 0,
        value: 0,
      };
      node.children.push(child);
      node = child;
    }
  }

  // playout
  const toPlay = node.toPlay;
  const reward = passes >= 2 ? evaluate(b, komi, areaWeight) : playout(b, toPlay, komi, rand, areaWeight, passes);

  // backpropagation: reward is from black's perspective
  for (let n: Node | null = node; n; n = n.parent) {
    n.visits++;
    // value is from the perspective of the player who moved INTO n (= other(n.toPlay))
    n.value += other(n.toPlay) === BLACK ? reward : 1 - reward;
  }
}

function select(node: Node): Node {
  const logN = Math.log(node.visits + 1);
  let best = node.children[0];
  let bestScore = -Infinity;
  for (const c of node.children) {
    const s = c.visits === 0 ? Infinity : c.value / c.visits + C * Math.sqrt(logN / c.visits);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

/** Moves worth considering in the tree: legal, not filling our own eye; plus pass. */
function candidateMoves(b: Board, color: Color): number[] {
  const out: number[] = [];
  const size = b.N * b.N;
  for (let i = 0; i < size; i++) {
    if (b.cells[i] !== EMPTY || b.isEye(i, color)) continue;
    const c = b.clone();
    if (c.play(i, color) >= 0) out.push(i);
  }
  out.push(PASS);
  return out;
}

function evaluate(b: Board, komi: number, areaWeight: number): number {
  const s = b.score(komi);
  const win = s.black >= s.white ? 1 : 0;
  return (1 - areaWeight) * win + areaWeight * (s.black / (b.N * b.N));
}

function playout(b: Board, toPlay: Color, komi: number, rand: () => number, areaWeight: number, passes: number): number {
  const size = b.N * b.N;
  const maxMoves = size * 3;
  const empties: number[] = [];
  let color = toPlay;
  for (let m = 0; m < maxMoves && passes < 2; m++) {
    let played = false;
    // 1. capture an enemy chain in atari
    if (rand() < 0.85) {
      const enemy = other(color);
      for (let i = 0; i < size && !played; i++) {
        if (b.cells[i] !== enemy) continue;
        if (b.chain(i, 2) === 1) {
          const lib = b.lastLib;
          if (b.play(lib, color) >= 0) played = true;
        }
      }
    }
    // 2. random sensible move
    if (!played) {
      empties.length = 0;
      for (let i = 0; i < size; i++) if (b.cells[i] === EMPTY) empties.push(i);
      while (empties.length) {
        const k = Math.floor(rand() * empties.length);
        const i = empties[k];
        empties[k] = empties[empties.length - 1];
        empties.pop();
        if (b.isEye(i, color) || b.selfAtari(i, color)) continue;
        if (b.play(i, color) >= 0) {
          played = true;
          break;
        }
      }
    }
    passes = played ? 0 : passes + 1;
    color = other(color);
  }
  return evaluate(b, komi, areaWeight);
}

