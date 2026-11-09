// Infiltration decisions. Pure logic → 0 GB; infiltrate.ts reads the game's own minigame
// model (found through React) and feeds it the keys computed here.
//
// Games are identified by their fields, not class names (production builds may minify
// those). Each step returns the next keys to send, or `wait` when the game needs time
// (Slash: the guard isn't distracted yet; Minesweeper: still showing the mines).

export const KEYS = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", space: " " } as const;

const ARROW_KEYS: Record<string, string> = { "↑": KEYS.up, "↓": KEYS.down, "←": KEYS.left, "→": KEYS.right };
const CLOSING: Record<string, string> = { "[": "]", "<": ">", "(": ")", "{": "}" };

/** A plain snapshot of the model's fields (whatever the game has). */
export type Model = Record<string, unknown>;

export type Step = { game: string; keys: string[] } | { game: string; wait: true } | { game: "unknown"; wait: true };

/** Shortest wrap-around moves from `from` to `to` on a ring of `n`: positive = forward. */
export function ringMoves(from: number, to: number, n: number): number {
  const fwd = (((to - from) % n) + n) % n;
  return fwd <= n / 2 ? fwd : fwd - n;
}

/** Arrow keys to move a cursor on a w×h wrap-around grid. */
export function gridPath(x: number, y: number, tx: number, ty: number, w: number, h: number): string[] {
  const dx = ringMoves(x, tx, w);
  const dy = ringMoves(y, ty, h);
  return [
    ...Array<string>(Math.abs(dx)).fill(dx > 0 ? KEYS.right : KEYS.left),
    ...Array<string>(Math.abs(dy)).fill(dy > 0 ? KEYS.down : KEYS.up),
  ];
}

export function identify(m: Model): string {
  if ("code" in m && "index" in m) return "cheatcode";
  if ("phase" in m && "distractedTime" in m) return "slash";
  if ("left" in m && "right" in m) return "bracket";
  if ("grid" in m && "answers" in m) return "cyberpunk";
  if ("choices" in m && "correctIndex" in m) return "bribe";
  if ("minefield" in m && "answer" in m) return "minesweeper";
  if ("wires" in m && "wiresToCut" in m) return "wirecutting";
  if ("guess" in m && "answer" in m) return "backward";
  if ("count" in m) return "countdown";
  return "unknown";
}

/** The next keys for the current game, given a snapshot of its model. */
export function nextStep(m: Model): Step {
  const game = identify(m);
  switch (game) {
    case "cheatcode": {
      const code = m.code as string[];
      const key = ARROW_KEYS[code[m.index as number]];
      return key ? { game, keys: [key] } : { game, wait: true };
    }
    case "slash":
      return m.phase === 1 ? { game, keys: [KEYS.space] } : { game, wait: true };
    case "bracket": {
      const left = m.left as string;
      const right = m.right as string;
      const open = left[left.length - 1 - right.length];
      return open ? { game, keys: [CLOSING[open]] } : { game, wait: true };
    }
    case "cyberpunk": {
      const grid = m.grid as string[][];
      const want = (m.answers as string[])[m.currentAnswerIndex as number];
      const h = grid.length;
      const w = grid[0]?.length ?? 0;
      let best: string[] | null = null;
      for (let ty = 0; ty < h; ty++)
        for (let tx = 0; tx < w; tx++) {
          if (grid[ty][tx] !== want) continue;
          const p = gridPath(m.x as number, m.y as number, tx, ty, w, h);
          if (!best || p.length < best.length) best = p;
        }
      return best ? { game, keys: [...best, KEYS.space] } : { game, wait: true };
    }
    case "bribe": {
      const n = (m.choices as string[]).length;
      const d = ringMoves(m.index as number, m.correctIndex as number, n);
      // up/right moves the selection forward, down/left backward
      return { game, keys: [...Array<string>(Math.abs(d)).fill(d > 0 ? KEYS.up : KEYS.down), KEYS.space] };
    }
    case "minesweeper": {
      if (m.memoryPhase) return { game, wait: true };
      const mines = m.minefield as boolean[][];
      const marked = m.answer as boolean[][];
      const h = mines.length;
      const w = mines[0]?.length ?? 0;
      let best: string[] | null = null;
      for (let ty = 0; ty < h; ty++)
        for (let tx = 0; tx < w; tx++) {
          if (!mines[ty][tx] || marked[ty][tx]) continue;
          const p = gridPath(m.x as number, m.y as number, tx, ty, w, h);
          if (!best || p.length < best.length) best = p;
        }
      return best ? { game, keys: [...best, KEYS.space] } : { game, wait: true };
    }
    case "wirecutting": {
      const cut = m.cutWires as boolean[];
      const toCut = [...(m.wiresToCut as Iterable<number>)].filter((i) => !cut[i]);
      return toCut.length ? { game, keys: [String(toCut[0] + 1)] } : { game, wait: true };
    }
    case "backward": {
      const answer = m.answer as string;
      const guess = m.guess as string;
      const next = answer[guess.length];
      return next !== undefined ? { game, keys: [next] } : { game, wait: true };
    }
    default:
      return { game: game === "countdown" ? "countdown" : "unknown", wait: true } as Step;
  }
}

// ---------- target choice ----------

export interface InfiltrationConfig {
  /** never attempt locations at or above this difficulty (the game's cap is 3.5) */
  maxDifficulty: number;
  /** seconds per clearance level before measurements exist (countdown + one game) */
  secPerLevel: number;
  /** infiltrate only when its rep/s beats faction work by this factor */
  margin: number;
  /** move on when a location's measured reward falls below this share of its first run */
  decayFloor: number;
  /** stop below this share of max HP (failures cost HP) */
  minHpFrac: number;
}

export const DEFAULT_INFILTRATION: InfiltrationConfig = {
  maxDifficulty: 3,
  secPerLevel: 3,
  margin: 1.2,
  decayFloor: 0.5,
  minHpFrac: 0.5,
};

export interface TargetInfo {
  name: string;
  city: string;
  difficulty: number;
  levels: number;
  tradeRep: number;
  sellCash: number;
}

export interface Measured {
  /** EMA of faction rep per second of run time */
  repPerSec: number;
  /** rep of the first measured run (reward decay reference) */
  firstRep: number;
  lastRep: number;
  runs: number;
}

/** Estimated rep/s: measured if we have runs (and it hasn't decayed out), else from the API. */
export function estimateRepPerSec(t: TargetInfo, m: Measured | undefined, cfg: InfiltrationConfig = DEFAULT_INFILTRATION): number {
  if (m && m.runs > 0) return m.lastRep < m.firstRep * cfg.decayFloor ? 0 : m.repPerSec;
  return t.tradeRep / Math.max(1, t.levels * cfg.secPerLevel);
}

export function chooseTarget(
  targets: TargetInfo[],
  measured: Record<string, Measured>,
  cfg: InfiltrationConfig = DEFAULT_INFILTRATION,
): { target: TargetInfo; repPerSec: number } | null {
  let best: { target: TargetInfo; repPerSec: number } | null = null;
  for (const t of targets) {
    if (!(t.difficulty < cfg.maxDifficulty) || t.levels <= 0) continue;
    const r = estimateRepPerSec(t, measured[t.name], cfg);
    if (r > 0 && (!best || r > best.repPerSec)) best = { target: t, repPerSec: r };
  }
  return best;
}

export function recordRun(prev: Measured | undefined, rep: number, seconds: number): Measured {
  const rate = rep / Math.max(1, seconds);
  if (!prev || prev.runs === 0) return { repPerSec: rate, firstRep: rep, lastRep: rep, runs: 1 };
  return { repPerSec: prev.repPerSec + 0.3 * (rate - prev.repPerSec), firstRep: prev.firstRep, lastRep: rep, runs: prev.runs + 1 };
}
