// Stock manager: buys market access, then trades every market update with 4S forecasts
// (decisions in lib/plan/stocks.ts). Steered by data/stocks-config.txt from the daemon:
//   trade       false while casino.js bets (money must stay put) — positions are held
//   cfg         overrides for DEFAULT_STOCKS
// Writes data/stocks.txt; the daemon counts `value` as money when planning, and
// tasks/install.js sells everything first (installing wipes positions without paying out).
import type { NS } from "@ns";
import { appendJsonl, readJson, writeJson } from "../lib/io.js";
import {
  decideTrades,
  DEFAULT_PRE,
  DEFAULT_STOCKS,
  newShadow,
  positionValue,
  preForecast,
  preVerdict,
  shadowStep,
  type ShadowState,
  type PreConfig,
  type StockConfig,
  type StockInfo,
} from "../lib/plan/stocks.js";

/** mid prices per symbol, newest last (pre-4S estimates); saved so restarts need no warm-up */
const HISTORY = "data/stock-history.txt";
const HISTORY_LEN = 60;
import { DATA } from "../lib/paths.js";

export interface StocksControl {
  trade: boolean;
  /** buy WSE/TIX/4S API access once these cost at most this fraction of cash */
  accessBudgetFrac?: number;
  cfg?: Partial<StockConfig>;
  /** pre-4S trading from price history (until the 4S TIX API is bought) */
  pre4s?: boolean;
  preCfg?: Partial<PreConfig>;
}

export interface StocksStatus {
  t: number;
  access: { wse: boolean; tix: boolean; api4s: boolean };
  /** liquidation value of every position */
  value: number;
  positions: number;
  /** realized profit from closed positions since this manager started (net of commissions) */
  realized: number;
  trades: number;
  note: string;
  /** "4S", "pre-4S" or "waiting" */
  mode: string;
  /** pre-4S results (kept across restarts) and the self-analysis verdict on real entries */
  pre: { realized: number; closed: number; stopped: boolean; recent?: number[]; verdict?: string; edge?: number; samples?: number; etaTo4sMin?: number };
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const S = ns.stock;
  const C = S.getConstants();
  let realized = 0;
  let trades = 0;
  /** shorting needs SF8.2 (or BitNode 8): buyShort throws without it, so stop trying */
  let shortsOk = true;
  const prev = readJson<Partial<StocksStatus>>(ns, DATA.stocks, {});
  const pre = { realized: 0, closed: 0, stopped: false, ...prev.pre };
  const saved = readJson<{ t?: number; prices?: Record<string, number[]>; shadow?: ShadowState }>(ns, HISTORY, {});
  // the shadow's record is evidence about the estimator, not the moment: keep it across gaps
  const shadow: ShadowState = saved.shadow ?? newShadow();
  let lastAllow: boolean | null = null;
  // a short gap (restart) is fine; a long one would splice two unrelated stretches together
  const history = new Map<string, number[]>(Date.now() - (saved.t ?? 0) < 120_000 ? Object.entries(saved.prices ?? {}) : []);

  while (true) {
    const ctl = readJson<StocksControl>(ns, DATA.stocksConfig, { trade: false });
    const cfg: StockConfig = { ...DEFAULT_STOCKS, ...ctl.cfg };
    if (!shortsOk) cfg.allowShorts = false;
    const cash = () => ns.getServerMoneyAvailable("home");
    const status: StocksStatus = {
      t: Date.now(),
      access: { wse: S.hasWseAccount(), tix: S.hasTixApiAccess(), api4s: S.has4SDataTixApi() },
      value: 0,
      positions: 0,
      realized,
      trades,
      note: "",
      mode: "waiting",
      pre,
    };

    // ---- access (one-off per BitNode; it survives installs) ----
    const frac = ctl.accessBudgetFrac ?? 0.2;
    const acquire = (have: boolean, cost: number, what: string, fn: () => boolean) => {
      if (have) return true;
      // base costs: BitNode multipliers may raise them, then the purchase just fails until affordable
      if (!ctl.trade || cost > cash() * frac || !fn()) return false;
      appendJsonl(ns, DATA.events, { t: Date.now(), kind: "stocks", msg: `bought ${what}` });
      return true;
    };
    const wse = acquire(status.access.wse, C.WseAccountCost, "a WSE account", () => S.purchaseWseAccount());
    const tix = wse && acquire(status.access.tix, C.TixApiCost, "TIX API access", () => S.purchaseTixApi());
    const api = tix && acquire(status.access.api4s, C.MarketDataTixApi4SCost, "4S Market Data TIX API", () => S.purchase4SMarketDataTixApi());
    status.access = { wse, tix, api4s: api };
    // the stock page's own 4S view (forecasts in the UI): scripts don't need it, but once it's
    // pocket change it lets you see what the trader sees
    if (api && !S.has4SData() && C.MarketData4SCost <= cash() * 0.01 && ctl.trade && S.purchase4SMarketData())
      appendJsonl(ns, DATA.events, { t: Date.now(), kind: "stocks", msg: "bought 4S Market Data (forecasts on the stock page)" });
    const preCfg: PreConfig = { ...DEFAULT_PRE, ...ctl.preCfg };
    const preOn = ctl.pre4s !== false;
    if (!tix || (!api && !preOn)) {
      status.note = "waiting to afford market access (WSE → TIX API → 4S TIX API)";
      writeJson(ns, DATA.stocks, status);
      await ns.sleep(30_000);
      continue;
    }
    status.mode = api ? "4S" : "pre-4S";

    // ---- market ----
    const ready = new Set<string>();
    const stocks: StockInfo[] = S.getSymbols().map((sym) => {
      const [long, longAvg, short, shortAvg] = S.getPosition(sym);
      const ask = S.getAskPrice(sym);
      const bid = S.getBidPrice(sym);
      const h = [...(history.get(sym) ?? []), (ask + bid) / 2].slice(-HISTORY_LEN);
      history.set(sym, h);
      let forecast: number;
      let volatility: number;
      if (api) {
        forecast = S.getForecast(sym);
        volatility = S.getVolatility(sym);
        ready.add(sym);
      } else {
        const est = preForecast(h, preCfg);
        forecast = est.forecast;
        volatility = est.volatility;
        if (est.ready) ready.add(sym);
      }
      return { sym, forecast, volatility, ask, bid, maxShares: S.getMaxShares(sym), long, longAvg, short, shortAvg };
    });
    // ---- pre-4S self-analysis: paper trades, 4S ETA, verdict ----
    let allowEntries = true;
    if (!api) {
      const readyStocks = stocks.filter((s) => ready.has(s.sym));
      shadowStep(shadow, readyStocks, preCfg.enterEdge, cfg.exitAt);
      const worth = cash() + stocks.reduce((a, s) => a + positionValue(s), 0);
      const needed = C.MarketDataTixApi4SCost / frac;
      const income = readJson<{ metrics?: { long?: { income?: number } } }>(ns, DATA.status, {}).metrics?.long?.income ?? 0;
      const eta = worth >= needed ? 0 : income > 0 ? (needed - worth) / income : Infinity;
      pre.etaTo4sMin = Number.isFinite(eta) ? eta / 60 : undefined;
      // net worth covers 4S but cash doesn't: free the cash (4S is bought next tick)
      if (worth >= needed && cash() < needed && ctl.trade) {
        for (const s of stocks) {
          if (s.long > 0) S.sellStock(s.sym, s.long);
          if (s.short > 0) S.sellShort(s.sym, s.short);
        }
        appendJsonl(ns, DATA.events, { t: Date.now(), kind: "stocks", msg: "sold pre-4S positions to buy the 4S TIX API" });
      }
      const typical = Math.max(1, (worth * (1 - cfg.reserveFrac)) / 4);
      const v = preVerdict(shadow.returns, (2 * C.StockMarketCommission) / typical, pre.recent ?? [], eta, preCfg);
      allowEntries = v.trade;
      if (v.trade !== lastAllow) {
        appendJsonl(ns, DATA.events, { t: Date.now(), kind: "stocks", msg: `pre-4S entries ${v.trade ? "on" : "off"}: ${v.why}` });
        lastAllow = v.trade;
      }
      Object.assign(pre, { verdict: v.why, edge: v.edge, samples: v.samples, stopped: !v.trade });
    }
    writeJson(ns, HISTORY, { t: Date.now(), prices: Object.fromEntries(history), shadow });

    if (ctl.trade) {
      const bySym = new Map(stocks.map((s) => [s.sym, s]));
      // pre-4S: wider entry edge; stocks still warming up are left alone entirely (their
      // neutral 0.5 estimate would otherwise close positions); a losing record stops entries
      const tradeCfg = api ? cfg : { ...cfg, enterEdge: preCfg.enterEdge };
      let decided = decideTrades(stocks.filter((s) => ready.has(s.sym)), cash(), C.StockMarketCommission, tradeCfg);
      if (!allowEntries) decided = decided.filter((t) => t.kind === "sellLong" || t.kind === "sellShort");
      for (const t of decided) {
        const s = bySym.get(t.sym)!;
        let price = 0;
        if (t.kind === "sellLong") {
          price = S.sellStock(t.sym, t.shares);
          if (price) {
            const pl = t.shares * (price - s.longAvg) - 2 * C.StockMarketCommission; // both legs' fees
            realized += pl;
            if (!api) {
              [pre.realized, pre.closed] = [pre.realized + pl, pre.closed + 1];
              pre.recent = [...(pre.recent ?? []), pl].slice(-20);
            }
          }
        } else if (t.kind === "sellShort") {
          price = S.sellShort(t.sym, t.shares);
          if (price) {
            const pl = t.shares * (s.shortAvg - price) - 2 * C.StockMarketCommission;
            realized += pl;
            if (!api) {
              [pre.realized, pre.closed] = [pre.realized + pl, pre.closed + 1];
              pre.recent = [...(pre.recent ?? []), pl].slice(-20);
            }
          }
        } else if (t.kind === "buyLong") price = S.buyStock(t.sym, t.shares);
        else
          try {
            price = S.buyShort(t.sym, t.shares);
          } catch {
            shortsOk = false; // not unlocked
          }
        if (price) trades++;
      }
      if (!api && !pre.stopped && pre.closed >= preCfg.minTrades && pre.realized < 0) {
        pre.stopped = true;
        appendJsonl(ns, DATA.events, {
          t: Date.now(),
          kind: "stocks",
          msg: `pre-4S trading stopped: ${pre.closed} closed trades lost $${ns.format.number(-pre.realized)} (only exits from now on)`,
        });
      }
      if (!api && ready.size < stocks.length) status.note = `pre-4S: ${ready.size}/${stocks.length} stocks have enough history`;
      else if (!api && pre.stopped) status.note = "pre-4S stopped (losing record): exits only";
    } else status.note = "paused (casino running)";

    // re-read positions after trading for an accurate value
    let value = 0;
    let positions = 0;
    for (const s of stocks) {
      const [long, longAvg, short, shortAvg] = S.getPosition(s.sym);
      const v = positionValue({ ...s, long, longAvg, short, shortAvg });
      if (long > 0 || short > 0) positions++;
      value += v;
    }
    Object.assign(status, { value, positions, realized, trades });
    writeJson(ns, DATA.stocks, status);
    await S.nextUpdate();
  }
}
