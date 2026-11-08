// IPvGO rules engine (written from scratch). Pure logic → 0 GB.
//
// Board layout matches ns.go.getBoardState(): an array of column strings, so the point
// (x, y) is cols[x][y]; "X" black (us), "O" white, "." empty, "#" offline (not playable,
// not territory). Index i = x * N + y.
//
// Rules as implemented by the game (v3.0.1 src/Go):
//   - a move is legal if the point is empty and the placed chain ends with a liberty,
//     possibly by capturing (no suicide)
//   - positional superko: a move may not recreate any earlier board of the game
//   - scoring is area scoring with NO dead-stone removal: stones on the board + empty
//     regions bordered by only one color; white also gets komi; ties go to black

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
export const DEAD = 3;
export type Color = typeof BLACK | typeof WHITE;
export const other = (c: Color): Color => (c === BLACK ? WHITE : BLACK);

export class Geometry {
  readonly size: number;
  /** neighbors of i: nb[i*4 .. i*4+3], -1 = none */
  readonly nb: Int16Array;
  /** diagonal neighbors, same layout */
  readonly diag: Int16Array;
  constructor(readonly N: number) {
    this.size = N * N;
    this.nb = new Int16Array(this.size * 4).fill(-1);
    this.diag = new Int16Array(this.size * 4).fill(-1);
    for (let x = 0; x < N; x++)
      for (let y = 0; y < N; y++) {
        const i = x * N + y;
        const put = (arr: Int16Array, list: [number, number][]) => {
          let k = 0;
          for (const [a, b] of list) if (a >= 0 && b >= 0 && a < N && b < N) arr[i * 4 + k++] = a * N + b;
        };
        put(this.nb, [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]);
        put(this.diag, [[x - 1, y - 1], [x + 1, y - 1], [x - 1, y + 1], [x + 1, y + 1]]);
      }
  }
}

const geometries = new Map<number, Geometry>();
export function geometry(N: number): Geometry {
  let g = geometries.get(N);
  if (!g) geometries.set(N, (g = new Geometry(N)));
  return g;
}

export function parse(cols: string[]): Int8Array {
  const N = cols.length;
  const b = new Int8Array(N * N);
  for (let x = 0; x < N; x++)
    for (let y = 0; y < N; y++) {
      const ch = cols[x][y];
      b[x * N + y] = ch === "X" ? BLACK : ch === "O" ? WHITE : ch === "#" ? DEAD : EMPTY;
    }
  return b;
}

export function toCols(b: Int8Array, N: number): string[] {
  const chars = [".", "X", "O", "#"];
  const out: string[] = [];
  for (let x = 0; x < N; x++) {
    let s = "";
    for (let y = 0; y < N; y++) s += chars[b[x * N + y]];
    out.push(s);
  }
  return out;
}

/** Compact key for superko checks. */
export const key = (b: Int8Array): string => String.fromCharCode(...b.map((v) => 48 + v));

/**
 * Mutable board with fast chain/liberty queries (stamp arrays instead of Sets).
 */
export class Board {
  readonly g: Geometry;
  readonly cells: Int8Array;
  private stamp: Int32Array;
  private libStamp: Int32Array;
  private epoch = 1;
  private stack: Int16Array;
  /** scratch: stones of the last chain() call */
  readonly chainStones: Int16Array;
  chainLen = 0;
  /** scratch: one liberty of the last chain() call (valid when libs >= 1) */
  lastLib = -1;

  constructor(
    readonly N: number,
    cells?: Int8Array,
  ) {
    this.g = geometry(N);
    this.cells = cells ? Int8Array.from(cells) : new Int8Array(N * N);
    this.stamp = new Int32Array(N * N);
    this.libStamp = new Int32Array(N * N);
    this.stack = new Int16Array(N * N);
    this.chainStones = new Int16Array(N * N);
  }

  clone(): Board {
    return new Board(this.N, this.cells);
  }

  /** Flood-fill the chain at i; returns its liberty count (stones in chainStones/chainLen). */
  chain(i: number, libLimit = 1e9): number {
    const color = this.cells[i];
    const e = ++this.epoch;
    const { nb } = this.g;
    let sp = 0;
    let libs = 0;
    this.chainLen = 0;
    this.stack[sp++] = i;
    this.stamp[i] = e;
    while (sp) {
      const p = this.stack[--sp];
      this.chainStones[this.chainLen++] = p;
      for (let k = 0; k < 4; k++) {
        const q = nb[p * 4 + k];
        if (q < 0) break;
        const c = this.cells[q];
        if (c === EMPTY) {
          if (this.libStamp[q] !== e) {
            this.libStamp[q] = e;
            libs++;
            this.lastLib = q;
            if (libs >= libLimit) return libs;
          }
        } else if (c === color && this.stamp[q] !== e) {
          this.stamp[q] = e;
          this.stack[sp++] = q;
        }
      }
    }
    return libs;
  }

  /**
   * Play `color` at i in place. Returns the number of captured stones, or -1 if the
   * move is illegal (occupied / suicide; superko is checked by the caller).
   */
  play(i: number, color: Color): number {
    const { cells } = this;
    if (cells[i] !== EMPTY) return -1;
    const { nb } = this.g;
    const enemy = other(color);
    cells[i] = color;
    let captured = 0;
    for (let k = 0; k < 4; k++) {
      const q = nb[i * 4 + k];
      if (q < 0) break;
      if (cells[q] === enemy && this.chain(q, 1) === 0) {
        for (let s = 0; s < this.chainLen; s++) cells[this.chainStones[s]] = EMPTY;
        captured += this.chainLen;
      }
    }
    if (captured === 0 && this.chain(i, 1) === 0) {
      cells[i] = EMPTY;
      return -1;
    }
    return captured;
  }

  /** Would playing here leave our own chain with exactly one liberty (and capture nothing)? */
  selfAtari(i: number, color: Color): boolean {
    const copy = this.clone();
    const cap = copy.play(i, color);
    if (cap < 0) return true;
    if (cap > 0) return false;
    return copy.chain(i, 2) < 2;
  }

  /** A simple eye of `color`: all orthogonal neighbors are ours (or edge/offline), and the diagonals aren't enemy-dominated. */
  isEye(i: number, color: Color): boolean {
    const { cells } = this;
    if (cells[i] !== EMPTY) return false;
    const { nb, diag } = this.g;
    let edge = false;
    for (let k = 0; k < 4; k++) {
      const q = nb[i * 4 + k];
      if (q < 0) {
        edge = true;
        break;
      }
      const c = cells[q];
      if (c !== color && c !== DEAD) return false;
    }
    let neighbors = 0;
    for (let k = 0; k < 4; k++) if (nb[i * 4 + k] >= 0) neighbors++;
    if (neighbors < 4) edge = true;
    let bad = 0;
    let diags = 0;
    for (let k = 0; k < 4; k++) {
      const q = diag[i * 4 + k];
      if (q < 0) break;
      diags++;
      if (cells[q] === other(color)) bad++;
    }
    return edge || diags < 4 ? bad === 0 : bad <= 1;
  }

  /** Area score as the game counts it. */
  score(komi: number): { black: number; white: number } {
    const { cells, N } = this;
    const size = N * N;
    let black = 0;
    let white = komi;
    const seen = new Uint8Array(size);
    const { nb } = this.g;
    const stack: number[] = [];
    for (let i = 0; i < size; i++) {
      const c = cells[i];
      if (c === BLACK) black++;
      else if (c === WHITE) white++;
      else if (c === EMPTY && !seen[i]) {
        // empty region: whose territory?
        let region = 0;
        let touchB = false;
        let touchW = false;
        stack.push(i);
        seen[i] = 1;
        while (stack.length) {
          const p = stack.pop()!;
          region++;
          for (let k = 0; k < 4; k++) {
            const q = nb[p * 4 + k];
            if (q < 0) break;
            const cq = cells[q];
            if (cq === EMPTY && !seen[q]) {
              seen[q] = 1;
              stack.push(q);
            } else if (cq === BLACK) touchB = true;
            else if (cq === WHITE) touchW = true;
          }
        }
        if (touchB && !touchW) black += region;
        else if (touchW && !touchB) white += region;
      }
    }
    return { black, white };
  }
}

/** Legal moves for `color` (indices), honoring superko against `history` (board keys). */
export function legalMoves(b: Board, color: Color, history: Set<string>): number[] {
  const out: number[] = [];
  for (let i = 0; i < b.N * b.N; i++) {
    if (b.cells[i] !== EMPTY) continue;
    const copy = b.clone();
    if (copy.play(i, color) < 0) continue;
    if (history.has(key(copy.cells))) continue;
    out.push(i);
  }
  return out;
}
