// Stock manager: buys market access, then trades every market update with 4S forecasts
// (decisions in lib/plan/stocks.ts). Steered by data/stocks-config.txt from the daemon:
//   trade       false while casino.js bets (money must stay put) — positions are held
//   cfg         overrides for DEFAULT_STOCKS
// Writes data/stocks.txt; the daemon counts `value` as money when planning, and
// tasks/install.js sells everything first (installing wipes positions without paying out).
import type { NS } from "@ns";
import { appendJsonl, readJson, writeJson } from "../lib/io.js";
import { decideTrades, DEFAULT_STOCKS, positionValue, type StockConfig, type StockInfo } from "../lib/plan/stocks.js";
import { DATA } from "../lib/paths.js";

export interface StocksControl {
  trade: boolean;
  /** buy WSE/TIX/4S API access once these cost at most this fraction of cash */
  accessBudgetFrac?: number;
  cfg?: Partial<StockConfig>;
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
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const S = ns.stock;
  const C = S.getConstants();
  let realized = 0;
  let trades = 0;
  /** shorting needs SF8.2 (or BitNode 8): buyShort throws without it, so stop trying */
  let shortsOk = true;

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
    if (!api) {
      status.note = "waiting to afford market access (WSE → TIX API → 4S TIX API)";
      writeJson(ns, DATA.stocks, status);
      await ns.sleep(30_000);
      continue;
    }

    // ---- market ----
    const stocks: StockInfo[] = S.getSymbols().map((sym) => {
      const [long, longAvg, short, shortAvg] = S.getPosition(sym);
      return {
        sym,
        forecast: S.getForecast(sym),
        volatility: S.getVolatility(sym),
        ask: S.getAskPrice(sym),
        bid: S.getBidPrice(sym),
        maxShares: S.getMaxShares(sym),
        long,
        longAvg,
        short,
        shortAvg,
      };
    });

    if (ctl.trade) {
      const bySym = new Map(stocks.map((s) => [s.sym, s]));
      for (const t of decideTrades(stocks, cash(), C.StockMarketCommission, cfg)) {
        const s = bySym.get(t.sym)!;
        let price = 0;
        if (t.kind === "sellLong") {
          price = S.sellStock(t.sym, t.shares);
          if (price) realized += t.shares * (price - s.longAvg) - C.StockMarketCommission;
        } else if (t.kind === "sellShort") {
          price = S.sellShort(t.sym, t.shares);
          if (price) realized += t.shares * (s.shortAvg - price) - C.StockMarketCommission;
        } else if (t.kind === "buyLong") price = S.buyStock(t.sym, t.shares);
        else
          try {
            price = S.buyShort(t.sym, t.shares);
          } catch {
            shortsOk = false; // not unlocked
          }
        if (price) trades++;
      }
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
