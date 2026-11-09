// Stock trading decisions from 4S data. Pure logic → 0 GB; stocks/manager.ts acts.
//
// Each tick a stock moves up with probability `forecast`, by up to `volatility` of its
// price, so the expected return per tick is ≈ (forecast − 0.5) × volatility.
//   - close a long once forecast ≤ exitAt (0.5), a short once forecast ≥ 1 − exitAt
//   - open where |forecast − 0.5| ≥ enterEdge (0.05), best expected return first,
//     long above 0.5, short below (shorts need SF8.2 / BitNode 8)
//   - keep at least reserveFrac of net worth in cash; skip trades too small for the
//     commission to be noise
// The game caps longs + shorts per stock at maxShares.

export interface StockInfo {
  sym: string;
  forecast: number;
  volatility: number;
  ask: number;
  bid: number;
  maxShares: number;
  long: number;
  longAvg: number;
  short: number;
  shortAvg: number;
}

export interface StockConfig {
  enterEdge: number;
  /** close when the forecast is back at/through this (0.5 = as soon as it turns) */
  exitAt: number;
  allowShorts: boolean;
  /** fraction of net worth kept as cash */
  reserveFrac: number;
  /** smallest order worth placing, as a multiple of the commission */
  minOrderCommissions: number;
}

export const DEFAULT_STOCKS: StockConfig = {
  enterEdge: 0.05,
  exitAt: 0.5,
  allowShorts: true,
  reserveFrac: 0.1,
  minOrderCommissions: 100,
};

export type Trade =
  | { kind: "sellLong" | "sellShort"; sym: string; shares: number }
  | { kind: "buyLong" | "buyShort"; sym: string; shares: number };

/** What every position would pay if closed now (long at bid; a short returns its stake ± the move). */
export function positionValue(s: StockInfo): number {
  return s.long * s.bid + s.short * (2 * s.shortAvg - s.ask);
}

export const expectedReturn = (s: StockInfo) => Math.abs(s.forecast - 0.5) * s.volatility;

export function decideTrades(stocks: StockInfo[], cash: number, commission: number, cfg: StockConfig = DEFAULT_STOCKS): Trade[] {
  const trades: Trade[] = [];
  let free = cash;

  // 1. exits (selling also frees cash for the buys below)
  for (const s of stocks) {
    if (s.long > 0 && s.forecast <= cfg.exitAt) {
      trades.push({ kind: "sellLong", sym: s.sym, shares: s.long });
      free += s.long * s.bid - commission;
    }
    if (s.short > 0 && s.forecast >= 1 - cfg.exitAt) {
      trades.push({ kind: "sellShort", sym: s.sym, shares: s.short });
      free += s.short * (2 * s.shortAvg - s.ask) - commission;
    }
  }
  const closed = new Set(trades.map((t) => `${t.sym}:${t.kind}`));

  // 2. entries, best expected return first
  const worth = cash + stocks.reduce((a, s) => a + positionValue(s), 0);
  let budget = free - worth * cfg.reserveFrac;
  const minOrder = commission * cfg.minOrderCommissions;
  const candidates = stocks
    .filter((s) => Math.abs(s.forecast - 0.5) >= cfg.enterEdge && (s.forecast > 0.5 || cfg.allowShorts))
    .sort((a, b) => expectedReturn(b) - expectedReturn(a));
  for (const s of candidates) {
    if (budget < minOrder) break;
    const goLong = s.forecast > 0.5;
    // positions on the other side are being closed above (or will be next tick)
    const held = (closed.has(`${s.sym}:sellLong`) ? 0 : s.long) + (closed.has(`${s.sym}:sellShort`) ? 0 : s.short);
    const room = s.maxShares - held;
    const price = goLong ? s.ask : s.bid; // shorts are opened at the bid
    const shares = Math.floor(Math.min(room, (budget - commission) / price));
    if (shares <= 0 || shares * price < minOrder) continue;
    trades.push({ kind: goLong ? "buyLong" : "buyShort", sym: s.sym, shares });
    budget -= shares * price + commission;
  }
  return trades;
}

// ---------- pre-4S: forecasts estimated from price history ----------
//
// Each market tick a stock rises with probability `forecast` and the forecast flips sides
// now and then, so: forecast ≈ share of up-moves over the last `longWindow` ticks, and a
// short window that disagrees strongly with it means a flip — then the stock is treated as
// neutral (0.5), which closes positions and blocks entries. Entries need a wider edge than
// with 4S data, and the whole mode turns itself off if its closed trades lose money.

export interface PreConfig {
  longWindow: number;
  shortWindow: number;
  /** enter at |forecast − 0.5| ≥ this (4S uses 0.05) */
  enterEdge: number;
  /** a short window this far on the other side of 0.5 = trend flip */
  flipEdge: number;
  /** shadow trades needed before real ones; also the window for the real trades' brake */
  minTrades: number;
  /** no new entries when the 4S API is affordable within this many seconds */
  waitFor4sSec: number;
}

export const DEFAULT_PRE: PreConfig = { longWindow: 20, shortWindow: 8, enterEdge: 0.1, flipEdge: 0.1, minTrades: 10, waitFor4sSec: 900 };

/** Share of up-moves and mean |relative move| over the last `window` moves of `prices`. */
export function estimateFromPrices(prices: number[], window: number): { forecast: number; volatility: number; moves: number } {
  const p = prices.slice(-(window + 1));
  let ups = 0;
  let moves = 0;
  let absSum = 0;
  for (let i = 1; i < p.length; i++) {
    if (p[i] === p[i - 1]) continue;
    moves++;
    if (p[i] > p[i - 1]) ups++;
    absSum += Math.abs(p[i] - p[i - 1]) / p[i - 1];
  }
  return { forecast: moves ? ups / moves : 0.5, volatility: moves ? (2 * absSum) / moves : 0, moves };
}

/**
 * Pre-4S forecast for one stock: the long-window estimate, or 0.5 (neutral) while there's
 * too little history or the short window signals a flip. Volatility: 2 × mean |move| (moves
 * are uniform up to the volatility).
 */
export function preForecast(prices: number[], cfg: PreConfig = DEFAULT_PRE): { forecast: number; volatility: number; ready: boolean } {
  const long = estimateFromPrices(prices, cfg.longWindow);
  if (long.moves < cfg.longWindow) return { forecast: 0.5, volatility: long.volatility, ready: false };
  const short = estimateFromPrices(prices, cfg.shortWindow);
  const flipped =
    (long.forecast > 0.5 && short.forecast <= 0.5 - cfg.flipEdge) || (long.forecast < 0.5 && short.forecast >= 0.5 + cfg.flipEdge);
  return { forecast: flipped ? 0.5 : long.forecast, volatility: long.volatility, ready: true };
}

// ---------- pre-4S self-analysis ----------
//
// A shadow trader paper-trades every stock on the same signals (entry at the ask, exit at
// the bid, so the spread counts), costing nothing. Real pre-4S entries are only allowed
// while its recent closed trades beat the commissions, and the real trades' own recent
// record hasn't turned negative. Separately: don't open anything when the 4S API is about
// to be affordable — those trades would only cost fees and hold cash 4S needs.

export interface ShadowState {
  open: Record<string, { side: "L" | "S"; entry: number }>;
  /** fractional returns of closed shadow trades, newest last */
  returns: number[];
}

export const newShadow = (): ShadowState => ({ open: {}, returns: [] });

/** Advance the shadow trader one tick on `stocks` (estimated forecasts). */
export function shadowStep(st: ShadowState, stocks: StockInfo[], enterEdge: number, exitAt = 0.5, keep = 50): void {
  for (const s of stocks) {
    const pos = st.open[s.sym];
    if (pos && ((pos.side === "L" && s.forecast <= exitAt) || (pos.side === "S" && s.forecast >= 1 - exitAt))) {
      st.returns.push(pos.side === "L" ? s.bid / pos.entry - 1 : pos.entry / s.ask - 1);
      delete st.open[s.sym];
    }
    if (!st.open[s.sym]) {
      if (s.forecast >= 0.5 + enterEdge) st.open[s.sym] = { side: "L", entry: s.ask };
      else if (s.forecast <= 0.5 - enterEdge) st.open[s.sym] = { side: "S", entry: s.bid };
    }
  }
  if (st.returns.length > keep) st.returns.splice(0, st.returns.length - keep);
}

export interface PreVerdict {
  trade: boolean;
  why: string;
  /** mean shadow return per trade, net of the commission share */
  edge: number;
  samples: number;
}

/**
 * Should real pre-4S entries be allowed now?
 * `costFrac`: both legs' commissions as a fraction of a typical position.
 * `liveRecent`: P/L of the last real closed trades (newest last).
 * `etaTo4sSec`: time until the 4S API is affordable (Infinity if unknown).
 */
export function preVerdict(
  shadow: number[],
  costFrac: number,
  liveRecent: number[],
  etaTo4sSec: number,
  cfg: { minTrades: number; waitFor4sSec: number },
): PreVerdict {
  const n = shadow.length;
  const edge = n ? shadow.reduce((a, b) => a + b, 0) / n - costFrac : 0;
  if (etaTo4sSec <= cfg.waitFor4sSec)
    return { trade: false, why: `4S affordable in ~${Math.ceil(etaTo4sSec / 60)} min: waiting`, edge, samples: n };
  if (n < cfg.minTrades) return { trade: false, why: `learning: ${n}/${cfg.minTrades} shadow trades`, edge, samples: n };
  if (edge <= 0) return { trade: false, why: `shadow trades don't beat fees (${(edge * 100).toFixed(2)}%/trade)`, edge, samples: n };
  const live = liveRecent.slice(-cfg.minTrades);
  if (live.length >= cfg.minTrades && live.reduce((a, b) => a + b, 0) < 0)
    return { trade: false, why: "recent real trades lost money: paused", edge, samples: n };
  return { trade: true, why: `shadow edge +${(edge * 100).toFixed(2)}%/trade over ${n}`, edge, samples: n };
}
