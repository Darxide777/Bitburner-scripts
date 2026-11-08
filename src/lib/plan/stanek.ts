// Stanek's Gift layout solver and charge math. Pure logic → 0 GB.
//
// Game mechanics (v3.0.1 src/CotMG):
//   effect(fragment) = 1 + ln(highestCharge + 1)/60 · ((numCharge + 1)/5)^0.07 · power · boost · BN mult
//   boost            = product of the powers of every distinct Booster touching the fragment
//   highestCharge    = most threads (× core bonus) used in ONE chargeFragment call
// So for a fixed charge, a fragment's gain is proportional to power × boost, and the
// layout objective is Σ weight(type) · power · boost over placed stat fragments.
// Rotation/neighbor geometry below mirrors the game's Fragment.fullAt/neighbors exactly.
import type { Fragment } from "@ns";

export const BOOSTER = 18;

export interface Placement {
  id: number;
  x: number;
  y: number;
  rotation: number;
}

/** Weight per FragmentType number (see FragmentTypeEnum). Unlisted types are worth 0. */
export const DEFAULT_STANEK_WEIGHTS: Record<number, number> = {
  14: 4, // Rep: faction + company rep (the mid-game bottleneck)
  6: 2.5, // Hacking: skill + exp
  3: 2, // HackingSpeed
  4: 1, // HackingMoney
  5: 0.5, // HackingGrow
  7: 0.15, // Strength
  8: 0.15, // Defense
  9: 0.15, // Dexterity
  10: 0.15, // Agility
  16: 0.1, // Crime
};

const w = (f: Fragment, rot: number) => (rot % 2 === 0 ? f.shape[0].length : f.shape.length);
const h = (f: Fragment, rot: number) => (rot % 2 === 0 ? f.shape.length : f.shape[0].length);

/** Same as the game's Fragment.fullAt. */
export function fullAt(f: Fragment, x: number, y: number, rot: number): boolean {
  if (x < 0 || y < 0 || x >= w(f, rot) || y >= h(f, rot)) return false;
  let [sx, sy, mx, my] = [0, 0, 1, 1];
  if (rot === 1) [sx, sy, mx, my] = [w(f, rot) - 1, 0, -1, 1];
  else if (rot === 2) [sx, sy, mx, my] = [w(f, rot) - 1, h(f, rot) - 1, -1, -1];
  else if (rot === 3) [sx, sy, mx, my] = [0, h(f, rot) - 1, 1, -1];
  let [qx, qy] = [sx + mx * x, sy + my * y];
  if (rot % 2 === 1) [qx, qy] = [qy, qx];
  return f.shape[qy][qx];
}

export function cells(f: Fragment, rot: number): [number, number][] {
  const out: [number, number][] = [];
  for (let y = 0; y < h(f, rot); y++) for (let x = 0; x < w(f, rot); x++) if (fullAt(f, x, y, rot)) out.push([x, y]);
  return out;
}

/** Same as the game's Fragment.neighbors: empty cells orthogonally adjacent to the shape. */
export function neighbors(f: Fragment, rot: number): [number, number][] {
  const out: [number, number][] = [];
  const seen = new Set<string>();
  for (const [x, y] of cells(f, rot))
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (fullAt(f, nx, ny, rot) || seen.has(`${nx},${ny}`)) continue;
      seen.add(`${nx},${ny}`);
      out.push([nx, ny]);
    }
  return out;
}

export function coreBonus(cores: number): number {
  return 1 + (cores - 1) / 16;
}

/** The game's effect formula (without the BitNode multiplier unless given). */
export function fragmentEffect(highestCharge: number, numCharge: number, power: number, boost: number, bnMult = 1): number {
  return 1 + (Math.log(highestCharge + 1) / 60) * Math.pow((numCharge + 1) / 5, 0.07) * power * boost * bnMult;
}

// ---------- layout ----------

interface Geo {
  cells: [number, number][];
  nbrs: [number, number][];
}

class Board {
  occ: Int16Array; // placement index or -1
  constructor(
    readonly W: number,
    readonly H: number,
    readonly geo: (id: number, rot: number) => Geo,
    public placed: Placement[] = [],
  ) {
    this.occ = new Int16Array(W * H).fill(-1);
    placed.forEach((p, i) => this.mark(p, i));
  }
  private mark(p: Placement, v: number) {
    for (const [cx, cy] of this.geo(p.id, p.rotation).cells) this.occ[(p.y + cy) * this.W + p.x + cx] = v;
  }
  fits(p: Placement): boolean {
    for (const [cx, cy] of this.geo(p.id, p.rotation).cells) {
      const x = p.x + cx;
      const y = p.y + cy;
      if (x < 0 || y < 0 || x >= this.W || y >= this.H || this.occ[y * this.W + x] !== -1) return false;
    }
    return true;
  }
  add(p: Placement): void {
    this.placed.push(p);
    this.mark(p, this.placed.length - 1);
  }
  remove(i: number): Placement {
    const p = this.placed[i];
    this.placed.splice(i, 1);
    this.occ.fill(-1);
    this.placed.forEach((q, k) => this.mark(q, k));
    return p;
  }
  at(x: number, y: number): number {
    return x < 0 || y < 0 || x >= this.W || y >= this.H ? -1 : this.occ[y * this.W + x];
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function geometry(defs: Fragment[]): (id: number, rot: number) => Geo {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const cache = new Map<string, Geo>();
  return (id, rot) => {
    const k = `${id}:${rot}`;
    let g = cache.get(k);
    if (!g) {
      const f = byId.get(id)!;
      g = { cells: cells(f, rot), nbrs: neighbors(f, rot) };
      cache.set(k, g);
    }
    return g;
  };
}

function scoreBoard(b: Board, byId: Map<number, Fragment>, weights: Record<number, number>): number {
  let total = 0;
  b.placed.forEach((p) => {
    const f = byId.get(p.id)!;
    if (f.type === BOOSTER) return;
    const wt = weights[f.type] ?? 0;
    if (wt <= 0) return;
    const boosters = new Set<number>();
    for (const [nx, ny] of b.geo(p.id, p.rotation).nbrs) {
      const j = b.at(p.x + nx, p.y + ny);
      if (j >= 0 && byId.get(b.placed[j].id)!.type === BOOSTER) boosters.add(j);
    }
    let boost = 1;
    for (const j of boosters) boost *= byId.get(b.placed[j].id)!.power;
    total += wt * f.power * boost;
  });
  return total;
}

/** Layout objective: Σ weight(type) · power · boost over stat fragments. */
export function scoreLayout(defs: Fragment[], W: number, H: number, placed: Placement[], weights = DEFAULT_STANEK_WEIGHTS): number {
  const byId = new Map(defs.map((d) => [d.id, d]));
  return scoreBoard(new Board(W, H, geometry(defs), [...placed]), byId, weights);
}

export interface SolveOptions {
  iterations?: number;
  restarts?: number;
  seed?: number;
}

/**
 * Find a high-scoring layout: greedy start (heaviest stat fragments first), then
 * simulated annealing with add / remove / relocate moves; best of several restarts.
 */
export function solveLayout(
  defs: Fragment[],
  W: number,
  H: number,
  weights: Record<number, number> = DEFAULT_STANEK_WEIGHTS,
  opts: SolveOptions = {},
): { placements: Placement[]; score: number } {
  // 64 restarts ≈ 1s and land within ~1% of the best layouts found with much larger budgets
  const { iterations = 30_000, restarts = 64, seed = 12345 } = opts;
  const byId = new Map(defs.map((d) => [d.id, d]));
  const geo = geometry(defs);
  const useful = defs.filter((d) => d.type === BOOSTER || (weights[d.type] ?? 0) > 0);
  if (!useful.some((d) => d.type !== BOOSTER)) return { placements: [], score: 0 };
  const count = (b: Board, id: number) => b.placed.filter((p) => p.id === id).length;
  const limitOk = (b: Board, id: number) => count(b, id) < byId.get(id)!.limit;

  let best: { placements: Placement[]; score: number } = { placements: [], score: -1 };
  for (let r = 0; r < restarts; r++) {
    const rand = mulberry32(seed + r * 7919);
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const board = new Board(W, H, geo);

    // greedy start: stat fragments by weight × power, first fit
    const stats = useful
      .filter((d) => d.type !== BOOSTER)
      .sort((a, b) => (weights[b.type] ?? 0) * b.power - (weights[a.type] ?? 0) * a.power);
    for (const d of stats) {
      outer: for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          for (let rot = 0; rot < 4; rot++) {
            const p = { id: d.id, x, y, rotation: rot };
            if (board.fits(p)) {
              board.add(p);
              break outer;
            }
          }
    }

    let cur = scoreBoard(board, byId, weights);
    let runBest = { placements: board.placed.map((p) => ({ ...p })), score: cur };
    const tempStart = Math.max(0.5, cur * 0.1);
    for (let i = 0; i < iterations; i++) {
      const temp = tempStart * Math.pow(0.0005, i / iterations);
      const move = rand();
      let undo: () => void;
      if (move < 0.45 || board.placed.length === 0) {
        // add
        const d = pick(useful);
        if (!limitOk(board, d.id)) continue;
        const p = { id: d.id, x: Math.floor(rand() * W), y: Math.floor(rand() * H), rotation: Math.floor(rand() * 4) };
        if (!board.fits(p)) continue;
        board.add(p);
        undo = () => void board.remove(board.placed.length - 1);
      } else if (move < 0.7) {
        // remove
        const i0 = Math.floor(rand() * board.placed.length);
        const old = board.remove(i0);
        undo = () => board.add(old);
      } else {
        // relocate / rotate
        const i0 = Math.floor(rand() * board.placed.length);
        const old = board.remove(i0);
        const p = { id: old.id, x: Math.floor(rand() * W), y: Math.floor(rand() * H), rotation: Math.floor(rand() * 4) };
        if (!board.fits(p)) {
          board.add(old);
          continue;
        }
        board.add(p);
        undo = () => {
          board.remove(board.placed.length - 1);
          board.add(old);
        };
      }
      const next = scoreBoard(board, byId, weights);
      if (next >= cur || rand() < Math.exp((next - cur) / temp)) {
        cur = next;
        if (cur > runBest.score) runBest = { placements: board.placed.map((p) => ({ ...p })), score: cur };
      } else undo();
    }
    const polished = polish(new Board(W, H, geo, runBest.placements.map((p) => ({ ...p }))), useful, byId, weights);
    if (polished.score > best.score) best = polished;
  }
  // drop boosters that touch nothing useful (they only waste space)
  const pruned = best.placements.filter((p) => {
    if (byId.get(p.id)!.type !== BOOSTER) return true;
    const without = best.placements.filter((q) => q !== p);
    return scoreLayout(defs, W, H, without, weights) < best.score - 1e-9;
  });
  return { placements: pruned, score: scoreLayout(defs, W, H, pruned, weights) };
}

/**
 * Deterministic hill climb to a local optimum: repeatedly apply the single best
 * improving move among (a) adding any fragment anywhere and (b) moving/rotating any
 * placed fragment anywhere, until nothing improves.
 */
function polish(
  board: Board,
  useful: Fragment[],
  byId: Map<number, Fragment>,
  weights: Record<number, number>,
): { placements: Placement[]; score: number } {
  const { W, H } = board;
  let cur = scoreBoard(board, byId, weights);
  const allPositions = (id: number) => {
    const out: Placement[] = [];
    for (let rotation = 0; rotation < 4; rotation++)
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out.push({ id, x, y, rotation });
    return out;
  };
  for (let round = 0; round < 200; round++) {
    let bestGain = 1e-9;
    let apply: (() => void) | null = null;
    // (a) additions
    for (const d of useful) {
      if (board.placed.filter((p) => p.id === d.id).length >= d.limit) continue;
      for (const p of allPositions(d.id)) {
        if (!board.fits(p)) continue;
        board.add(p);
        const gain = scoreBoard(board, byId, weights) - cur;
        board.remove(board.placed.length - 1);
        if (gain > bestGain) {
          bestGain = gain;
          apply = () => board.add(p);
        }
      }
    }
    // (b) relocations / rotations
    for (let i = 0; i < board.placed.length; i++) {
      const old = board.remove(i);
      for (const p of allPositions(old.id)) {
        if (!board.fits(p)) continue;
        board.add(p);
        const gain = scoreBoard(board, byId, weights) - cur;
        board.remove(board.placed.length - 1);
        if (gain > bestGain) {
          bestGain = gain;
          const idx = i;
          apply = () => {
            board.remove(idx);
            board.add(p);
          };
        }
      }
      // put it back at its original index
      board.placed.splice(i, 0, old);
      board.occ.fill(-1);
      const tmp = board.placed.splice(0);
      for (const q of tmp) board.add(q);
    }
    if (!apply) break;
    apply();
    cur = scoreBoard(board, byId, weights);
  }
  return { placements: board.placed.map((p) => ({ ...p })), score: cur };
}

/** Grid size for a given SF13 level and BitNode extra size (game: StanekConstants.BaseSize = 9, MaxSize = 25). */
export function giftSize(sf13: number, extraSize = 0): { width: number; height: number } {
  const base = 9 + extraSize + sf13;
  return {
    width: Math.max(2, Math.min(Math.floor(base / 2 + 1), 25)),
    height: Math.max(3, Math.min(Math.floor(base / 2 + 0.6), 25)),
  };
}
