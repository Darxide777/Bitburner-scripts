// IPvGO matchup selection. Pure logic → 0 GB.
//
// Each finished game raises that opponent's bonus (the game's node power). The bonus
// curve is concave, so the gain per game shrinks the more we play an opponent — and
// every augment install resets it. We therefore pick the (opponent, board size) "arm"
// with the best *recent* weighted bonus gain per minute, using an exponential moving
// average per arm plus a UCB exploration term so alternatives get re-checked.
//
// Default: rotation instead — every available opponent gets a turn of `rotateMs`
// (15 min), in weight order, so every bonus grows; only the board size is chosen by
// measured gain per minute. rotateMs: 0 goes back to the pure best-value picker.

export interface GoConfig {
  enabled: boolean;
  /** Value of +1 percentage point of each opponent's bonus. */
  weights: Record<string, number>;
  sizes: number[];
  /** Thinking time per move, by board size. */
  timeMs: Record<string, number>;
  /** UCB exploration strength (relative to the best arm's value). */
  explore: number;
  /** EMA factor for per-arm gain and duration (0..1, higher = faster to adapt). */
  alpha: number;
  /** Turn length per opponent in rotation mode; 0 = always play the best-value arm. */
  rotateMs: number;
}

export const DEFAULT_GO: GoConfig = {
  enabled: true,
  weights: {
    Daedalus: 4, // faction + company rep
    Illuminati: 2, // hack/grow/weaken speed
    "????????????": 2.5, // hacking level (needs The Red Pill)
    "The Black Hand": 1, // hacking money
    Tetrads: 0.3, // combat stats
    "Slum Snakes": 0.2, // crime success
    Netburners: 0.1, // hacknet production
  },
  sizes: [5, 7],
  timeMs: { "5": 200, "7": 350, "9": 500, "13": 900 },
  explore: 0.3,
  alpha: 0.3,
  rotateMs: 15 * 60_000,
};

/** Whose turn it is in rotation mode, and since when. */
export interface Rotation {
  opponent: string;
  since: number;
}

/**
 * Rotation mode: keep the current opponent until its turn is over (or it's unavailable),
 * then move to the next one in a stable order (weight, then name). Board size within the
 * turn: chooseArm over that opponent alone (untried sizes first, then gain per minute).
 */
export function rotateArm(
  arms: Record<string, ArmStats>,
  opponents: string[],
  cfg: GoConfig,
  rot: Rotation | null,
  now: number,
): { opponent: string; size: number; rot: Rotation } {
  const cmp = (a: string, b: string) => (cfg.weights[b] ?? 0) - (cfg.weights[a] ?? 0) || a.localeCompare(b);
  const order = [...opponents].sort(cmp);
  if (!order.length) return { opponent: "Netburners", size: cfg.sizes[0] ?? 5, rot: { opponent: "Netburners", since: now } };
  let r = rot;
  const at = r ? order.indexOf(r.opponent) : -1;
  if (!r || at < 0) {
    // unavailable now: continue with whoever would have come after it (or start)
    const next = r ? (order.find((o) => cmp(o, r!.opponent) > 0) ?? order[0]) : order[0];
    r = { opponent: next, since: now };
  } else if (now - r.since >= cfg.rotateMs) r = { opponent: order[(at + 1) % order.length], since: now };
  const { size } = chooseArm(arms, [r.opponent], { ...cfg, weights: { [r.opponent]: 1 } });
  return { opponent: r.opponent, size, rot: r };
}

export interface ArmStats {
  games: number;
  wins: number;
  /** EMA of bonus percentage points gained per game */
  gain: number;
  /** EMA of game duration in ms */
  ms: number;
  lastScore: string;
}

export type ArmKey = `${string}@${number}`;
export const armKey = (opponent: string, size: number): ArmKey => `${opponent}@${size}`;

export function record(arms: Record<string, ArmStats>, k: ArmKey, won: boolean, gain: number, ms: number, score: string, alpha: number) {
  const a = arms[k] ?? { games: 0, wins: 0, gain, ms, lastScore: "" };
  a.games++;
  if (won) a.wins++;
  a.gain = a.games === 1 ? gain : a.gain + alpha * (gain - a.gain);
  a.ms = a.games === 1 ? ms : a.ms + alpha * (ms - a.ms);
  a.lastScore = score;
  arms[k] = a;
}

/** Weighted bonus per minute for an arm. */
export function armValue(a: ArmStats, weight: number): number {
  return (weight * Math.max(0, a.gain)) / Math.max(1 / 60, a.ms / 60_000);
}

export function chooseArm(arms: Record<string, ArmStats>, opponents: string[], cfg: GoConfig): { opponent: string; size: number } {
  const candidates: { opponent: string; size: number; weight: number }[] = [];
  for (const opponent of opponents) {
    const weight = cfg.weights[opponent] ?? 0;
    if (weight <= 0) continue;
    for (const size of cfg.sizes) candidates.push({ opponent, size, weight });
  }
  if (!candidates.length) return { opponent: "Netburners", size: 5 };
  // untried arms first, most valuable opponent first, smaller (faster) boards first
  const untried = candidates.filter((c) => !arms[armKey(c.opponent, c.size)]);
  if (untried.length) {
    const u = untried.sort((a, b) => b.weight - a.weight || a.size - b.size)[0];
    return { opponent: u.opponent, size: u.size };
  }

  const total = candidates.reduce((s, c) => s + arms[armKey(c.opponent, c.size)].games, 0);
  const values = candidates.map((c) => armValue(arms[armKey(c.opponent, c.size)], c.weight));
  const scale = Math.max(1e-9, ...values);
  let best = 0;
  let bestScore = -Infinity;
  candidates.forEach((c, i) => {
    const a = arms[armKey(c.opponent, c.size)];
    const ucb = values[i] + cfg.explore * scale * Math.sqrt(Math.log(total + 1) / a.games);
    if (ucb > bestScore) {
      bestScore = ucb;
      best = i;
    }
  });
  return { opponent: candidates[best].opponent, size: candidates[best].size };
}
