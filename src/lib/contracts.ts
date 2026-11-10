// Coding contract solvers. Pure logic → 0 GB; tasks/contracts.js finds and submits them.
// Keys are the game's contract type names (CodingContractName). Each solver takes the
// contract's data and returns the answer in its native format (attempt() accepts that).
// tasks/contracts-selftest.js checks every solver against the game's own dummy contracts.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Solver = (data: any) => unknown;

// ---------- helpers ----------

function largestPrimeFactor(n: number): number {
  let f = 2;
  let last = 1;
  while (f * f <= n) {
    if (n % f === 0) {
      last = f;
      n /= f;
    } else f += f === 2 ? 1 : 2;
  }
  return n > 1 ? n : last;
}

function stockMaxProfit(k: number, prices: number[]): number {
  if (prices.length < 2 || k <= 0) return 0;
  // with k ≥ n/2 the limit never binds: take every rise
  if (k >= prices.length / 2) {
    let p = 0;
    for (let i = 1; i < prices.length; i++) p += Math.max(0, prices[i] - prices[i - 1]);
    return p;
  }
  // holding[t] / flat[t]: best cash with t transactions used, holding a share or not.
  // (names picked so they never collide with API function names, which cost RAM: see README)
  const holding = new Array<number>(k + 1).fill(-Infinity);
  const flat = new Array<number>(k + 1).fill(0);
  for (const price of prices)
    for (let t = 1; t <= k; t++) {
      holding[t] = Math.max(holding[t], flat[t - 1] - price);
      flat[t] = Math.max(flat[t], holding[t] + price);
    }
  return flat[k];
}

function waysToSum(target: number, parts: number[]): number {
  const ways = new Array<number>(target + 1).fill(0);
  ways[0] = 1;
  for (const p of parts) for (let s = p; s <= target; s++) ways[s] += ways[s - p];
  return ways[target];
}

function sanitizeParentheses(s: string): string[] {
  const valid = (t: string) => {
    let open = 0;
    for (const c of t) {
      if (c === "(") open++;
      else if (c === ")" && --open < 0) return false;
    }
    return open === 0;
  };
  let level = new Set([s]);
  while (level.size) {
    const ok = [...level].filter(valid);
    if (ok.length) return ok;
    const next = new Set<string>();
    for (const t of level)
      for (let i = 0; i < t.length; i++) if (t[i] === "(" || t[i] === ")") next.add(t.slice(0, i) + t.slice(i + 1));
    level = next;
  }
  return [""];
}

function mathExpressions(digits: string, target: number): string[] {
  const out: string[] = [];
  const extend = (pos: number, expr: string, value: number, last: number) => {
    if (pos === digits.length) {
      if (value === target) out.push(expr);
      return;
    }
    for (let end = pos + 1; end <= digits.length; end++) {
      if (end > pos + 1 && digits[pos] === "0") break; // no multi-digit numbers with a leading 0
      const str = digits.slice(pos, end);
      const n = Number(str);
      if (pos === 0) extend(end, str, n, n);
      else {
        extend(end, `${expr}+${str}`, value + n, n);
        extend(end, `${expr}-${str}`, value - n, -n);
        extend(end, `${expr}*${str}`, value - last + last * n, last * n);
      }
    }
  };
  extend(0, "", 0, 0);
  return out;
}

/** The game's extended Hamming encoding (utils/HammingCodeTools.ts), MSB-first data bits. */
function hammingEncode(value: number): string {
  const bits = value.toString(2).split("").map(Number);
  const enc: number[] = [0];
  let k = 0;
  for (let i = 1; k < bits.length; i++) enc[i] = (i & (i - 1)) !== 0 ? bits[k++] : 0;
  let syndrome = 0;
  for (let i = 0; i < enc.length; i++) if (enc[i]) syndrome ^= i;
  for (let p = 0; 2 ** p < enc.length; p++) enc[2 ** p] = (syndrome >> p) & 1;
  enc[0] = enc.reduce((a, b) => a + b, 0) % 2;
  return enc.join("");
}

function hammingDecode(s: string): number {
  const bits = s.split("").map(Number);
  let err = 0;
  bits.forEach((b, i) => {
    if (b) err ^= i;
  });
  if (err) bits[err] ^= 1;
  let ans = "";
  for (let i = 1; i < bits.length; i++) if ((i & (i - 1)) !== 0) ans += bits[i];
  return parseInt(ans, 2);
}

function rle(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; ) {
    let n = 1;
    while (n < 9 && s[i + n] === s[i]) n++;
    out += `${n}${s[i]}`;
    i += n;
  }
  return out;
}

function lzDecompress(s: string): string {
  let out = "";
  let literal = true;
  for (let i = 0; i < s.length; literal = !literal) {
    const len = Number(s[i++]);
    if (literal) {
      out += s.slice(i, i + len);
      i += len;
    } else if (len > 0) {
      const off = Number(s[i++]);
      for (let k = 0; k < len; k++) out += out[out.length - off];
    }
  }
  return out;
}

/**
 * Shortest LZ encoding: the game's own DP (comprLZEncode), minus its random tie-breaks.
 * state[0][len]: ends in a literal of length len; state[off][len]: a backreference.
 */
function lzCompress(plain: string): string {
  type State = (string | null)[][];
  const fresh = (): State => Array.from({ length: 10 }, () => new Array<string | null>(10).fill(null));
  const set = (st: State, i: number, j: number, s: string) => {
    if (st[i][j] === null || s.length < st[i][j]!.length) st[i][j] = s;
  };
  let cur = fresh();
  cur[0][1] = "";
  for (let i = 1; i < plain.length; i++) {
    const next = fresh();
    const c = plain[i];
    for (let len = 1; len <= 9; len++) {
      const s = cur[0][len];
      if (s === null) continue;
      if (len < 9) set(next, 0, len + 1, s);
      else set(next, 0, 1, s + "9" + plain.substring(i - 9, i) + "0");
      for (let off = 1; off <= Math.min(9, i); off++)
        if (plain[i - off] === c) set(next, off, 1, s + String(len) + plain.substring(i - len, i));
    }
    for (let off = 1; off <= 9; off++)
      for (let len = 1; len <= 9; len++) {
        const s = cur[off][len];
        if (s === null) continue;
        if (plain[i - off] === c) {
          if (len < 9) set(next, off, len + 1, s);
          else set(next, off, 1, s + "9" + String(off) + "0");
        }
        set(next, 0, 1, s + String(len) + String(off));
        for (let no = 1; no <= Math.min(9, i); no++)
          if (plain[i - no] === c) set(next, no, 1, s + String(len) + String(off) + "0");
      }
    cur = next;
  }
  let best: string | null = null;
  const consider = (s: string) => {
    if (best === null || s.length < best.length) best = s;
  };
  for (let len = 1; len <= 9; len++) {
    const s = cur[0][len];
    if (s !== null) consider(s + String(len) + plain.substring(plain.length - len));
  }
  for (let off = 1; off <= 9; off++)
    for (let len = 1; len <= 9; len++) {
      const s = cur[off][len];
      if (s !== null) consider(s + String(len) + String(off));
    }
  return best ?? "";
}

function bigSqrtRounded(n: bigint): bigint {
  if (n < 2n) return n;
  // Newton's method for floor(sqrt(n)), then round to the nearer of r and r+1
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x && y - x <= 1n) break;
    x = y;
  }
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  // nearest: n - x² vs (x+1)² - n  ⇔  compare n with x² + x (+ 0.25)
  return n - x * x > x ? x + 1n : x;
}

function countPrimes(lo: number, hi: number): number {
  if (hi < 2 || hi < lo) return 0;
  lo = Math.max(lo, 2);
  const root = Math.floor(Math.sqrt(hi));
  const small = new Uint8Array(root + 1);
  const primes: number[] = [];
  for (let i = 2; i <= root; i++) {
    if (small[i]) continue;
    primes.push(i);
    for (let j = i * i; j <= root; j += i) small[j] = 1;
  }
  let count = 0;
  const SEG = 1 << 20;
  for (let start = lo; start <= hi; start += SEG) {
    const end = Math.min(hi, start + SEG - 1);
    const comp = new Uint8Array(end - start + 1);
    for (const p of primes) {
      let j = Math.max(p * p, Math.ceil(start / p) * p);
      for (; j <= end; j += p) comp[j - start] = 1;
    }
    for (let i = 0; i < comp.length; i++) if (!comp[i]) count++;
  }
  return count;
}

/** Largest all-`want` axis-aligned rectangle → [[r1, c1], [r2, c2]] (top-left, bottom-right). */
function largestRectangle(grid: number[][], want = 0): [[number, number], [number, number]] {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const h = new Array<number>(cols).fill(0);
  let best = { area: 0, r1: 0, c1: 0, r2: 0, c2: 0 };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) h[c] = grid[r][c] === want ? h[c] + 1 : 0;
    // largest rectangle in the histogram h (monotonic stack)
    const stack: number[] = [];
    for (let c = 0; c <= cols; c++) {
      const cur = c === cols ? 0 : h[c];
      while (stack.length && h[stack[stack.length - 1]] >= cur) {
        const height = h[stack.pop()!];
        const left = stack.length ? stack[stack.length - 1] + 1 : 0;
        const area = height * (c - left);
        if (area > best.area) best = { area, r1: r - height + 1, c1: left, r2: r, c2: c - 1 };
      }
      stack.push(c);
    }
  }
  return [
    [best.r1, best.c1],
    [best.r2, best.c2],
  ];
}

// ---------- solvers ----------

export const SOLVERS: Record<string, Solver> = {
  "Find Largest Prime Factor": (n: number) => largestPrimeFactor(n),

  "Subarray with Maximum Sum": (a: number[]) => {
    let best = -Infinity;
    let cur = 0;
    for (const x of a) {
      cur = Math.max(x, cur + x);
      best = Math.max(best, cur);
    }
    return best;
  },

  // ways to write n as a sum of at least two positive integers
  "Total Ways to Sum": (n: number) => waysToSum(n, Array.from({ length: Math.max(0, n - 1) }, (_, i) => i + 1)),

  "Total Ways to Sum II": ([n, parts]: [number, number[]]) => waysToSum(n, parts),

  "Spiralize Matrix": (m: number[][]) => {
    const out: number[] = [];
    let top = 0;
    let bottom = m.length - 1;
    let left = 0;
    let right = (m[0]?.length ?? 0) - 1;
    while (top <= bottom && left <= right) {
      for (let c = left; c <= right; c++) out.push(m[top][c]);
      top++;
      for (let r = top; r <= bottom; r++) out.push(m[r][right]);
      right--;
      if (top <= bottom) {
        for (let c = right; c >= left; c--) out.push(m[bottom][c]);
        bottom--;
      }
      if (left <= right) {
        for (let r = bottom; r >= top; r--) out.push(m[r][left]);
        left++;
      }
    }
    return out;
  },

  "Array Jumping Game": (a: number[]) => {
    let reach = 0;
    for (let i = 0; i < a.length && i <= reach; i++) reach = Math.max(reach, i + a[i]);
    return reach >= a.length - 1 ? 1 : 0;
  },

  // fewest jumps to the last index; 0 when it can't be reached
  "Array Jumping Game II": (a: number[]) => {
    if (a.length <= 1) return 0;
    let jumps = 0;
    let end = 0;
    let far = 0;
    for (let i = 0; i < a.length - 1; i++) {
      if (i > far) return 0;
      far = Math.max(far, i + a[i]);
      if (i === end) {
        jumps++;
        end = far;
        if (end >= a.length - 1) return jumps;
      }
    }
    return end >= a.length - 1 ? jumps : 0;
  },

  "Merge Overlapping Intervals": (iv: [number, number][]) => {
    const s = iv.map(([a, b]) => [a, b] as [number, number]).sort((x, y) => x[0] - y[0]);
    const out: [number, number][] = [];
    for (const [a, b] of s) {
      const last = out[out.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  },

  "Generate IP Addresses": (s: string) => {
    const out: string[] = [];
    const ok = (p: string) => p.length > 0 && p.length <= 3 && (p === "0" || p[0] !== "0") && Number(p) <= 255;
    for (let a = 1; a <= 3; a++)
      for (let b = 1; b <= 3; b++)
        for (let c = 1; c <= 3; c++) {
          const d = s.length - a - b - c;
          if (d < 1 || d > 3) continue;
          const parts = [s.slice(0, a), s.slice(a, a + b), s.slice(a + b, a + b + c), s.slice(a + b + c)];
          if (parts.every(ok)) out.push(parts.join("."));
        }
    return out;
  },

  "Algorithmic Stock Trader I": (p: number[]) => stockMaxProfit(1, p),
  "Algorithmic Stock Trader II": (p: number[]) => stockMaxProfit(p.length, p),
  "Algorithmic Stock Trader III": (p: number[]) => stockMaxProfit(2, p),
  "Algorithmic Stock Trader IV": ([k, p]: [number, number[]]) => stockMaxProfit(k, p),

  "Minimum Path Sum in a Triangle": (t: number[][]) => {
    const dp = [...t[t.length - 1]];
    for (let r = t.length - 2; r >= 0; r--) for (let c = 0; c <= r; c++) dp[c] = t[r][c] + Math.min(dp[c], dp[c + 1]);
    return dp[0];
  },

  "Unique Paths in a Grid I": ([rows, cols]: [number, number]) => {
    // C(rows + cols - 2, rows - 1), multiplicatively (exact for contract sizes)
    let r = 1;
    const n = rows + cols - 2;
    const k = Math.min(rows - 1, cols - 1);
    for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
    return Math.round(r);
  },

  "Unique Paths in a Grid II": (g: number[][]) => {
    const cols = g[0].length;
    const dp = new Array<number>(cols).fill(0);
    dp[0] = g[0][0] === 0 ? 1 : 0;
    for (const row of g)
      for (let c = 0; c < cols; c++) {
        if (row[c] === 1) dp[c] = 0;
        else if (c > 0) dp[c] += dp[c - 1];
      }
    return dp[cols - 1];
  },

  // BFS; "" when the bottom-right corner can't be reached
  "Shortest Path in a Grid": (g: number[][]) => {
    const R = g.length;
    const C = g[0].length;
    if (g[0][0] === 1 || g[R - 1][C - 1] === 1) return "";
    const prev = new Map<number, [number, string]>();
    const q = [0];
    const seen = new Set([0]);
    const moves: [number, number, string][] = [
      [-1, 0, "U"],
      [1, 0, "D"],
      [0, -1, "L"],
      [0, 1, "R"],
    ];
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      const r = Math.floor(cur / C);
      const c = cur % C;
      if (r === R - 1 && c === C - 1) {
        let path = "";
        for (let at = cur; at !== 0; ) {
          const [from, step] = prev.get(at)!;
          path = step + path;
          at = from;
        }
        return path;
      }
      for (const [dr, dc, step] of moves) {
        const nr = r + dr;
        const nc = c + dc;
        const id = nr * C + nc;
        if (nr < 0 || nc < 0 || nr >= R || nc >= C || g[nr][nc] === 1 || seen.has(id)) continue;
        seen.add(id);
        prev.set(id, [cur, step]);
        q.push(id);
      }
    }
    return "";
  },

  "Sanitize Parentheses in Expression": (s: string) => sanitizeParentheses(s),

  "Find All Valid Math Expressions": ([digits, target]: [string, number]) => mathExpressions(digits, target),

  "HammingCodes: Integer to Encoded Binary": (n: number) => hammingEncode(n),
  "HammingCodes: Encoded Binary to Integer": (s: string) => hammingDecode(s),

  // [] when the graph isn't bipartite
  "Proper 2-Coloring of a Graph": ([n, edges]: [number, [number, number][]]) => {
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (const [a, b] of edges) {
      adj[a].push(b);
      adj[b].push(a);
    }
    const color = new Array<number>(n).fill(-1);
    for (let s = 0; s < n; s++) {
      if (color[s] !== -1) continue;
      color[s] = 0;
      const q = [s];
      for (let qi = 0; qi < q.length; qi++) {
        const v = q[qi];
        for (const w of adj[v]) {
          if (color[w] === -1) {
            color[w] = 1 - color[v];
            q.push(w);
          } else if (color[w] === color[v]) return [];
        }
      }
    }
    return color;
  },

  "Compression I: RLE Compression": (s: string) => rle(s),
  "Compression II: LZ Decompression": (s: string) => lzDecompress(s),
  "Compression III: LZ Compression": (s: string) => lzCompress(s),

  // left shift by `shift`; everything but A–Z is kept
  "Encryption I: Caesar Cipher": ([text, shift]: [string, number]) =>
    text.replace(/[A-Z]/g, (ch) => String.fromCharCode(((((ch.charCodeAt(0) - 65 - shift) % 26) + 26) % 26) + 65)),

  "Encryption II: Vigenère Cipher": ([text, key]: [string, string]) => {
    let i = 0;
    return text.replace(/[A-Z]/g, (ch) => {
      const k = key.charCodeAt(i++ % key.length) - 65;
      return String.fromCharCode(((ch.charCodeAt(0) - 65 + k) % 26) + 65);
    });
  },

  // nearest integer square root of a bigint (see the self-test for the exact rule)
  "Square Root": (n: bigint | string | number) => bigSqrtRounded(BigInt(n)),

  // primes in [lo, hi] inclusive
  "Total Number of Primes": ([lo, hi]: [number, number]) => countPrimes(lo, hi),

  "Largest Rectangle in a Matrix": (g: number[][]) => largestRectangle(g, 0),
};

export const _internal = { hammingEncode, hammingDecode, lzCompress, lzDecompress, bigSqrtRounded, countPrimes, largestRectangle };
