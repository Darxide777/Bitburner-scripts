// Corporation manager (decisions in lib/plan/corp.ts). Every corporation function costs
// 10–20 GB, so all of them go through the call proxy (lib/call.ts): one temporary script
// per function, peak ~22 GB. Function names only appear inside strings here, and local
// names avoid corp API names, so this script itself stays tiny (see README "RAM model").
//
// Once per corp cycle, for each division (Agriculture, then Tobacco once affordable):
// cities → warehouses, Smart Supply, sell orders → offices (hire, job split, tea/parties)
// → optimal boost materials → research. Then: Plants exported Agriculture → Tobacco, the
// Tobacco product pipeline (develop in Aevum, retire the weakest, sell at MAX/MP or
// Market-TA.II), the cheapest affordable upgrade, investment rounds (accepted when the
// offer plateaus), going public, dividends (low while growth is affordable, high once
// saturated) and bribes for the planner's rep gap with idle funds.
// Steered by data/corp-config.txt from the daemon; status in data/corp.txt.
import type { NS } from "@ns";
import { call, callEach } from "../lib/call.js";
import { appendJsonl, readJson, writeJson } from "../lib/io.js";
import { DATA } from "../lib/paths.js";
import {
  bribeAmount,
  CITIES,
  cheapest,
  DEFAULT_CORP,
  DEV_CITY,
  dividendFor,
  EXPORT_AMOUNT,
  JOBS,
  offerPlateaued,
  optimalBoost,
  PRODUCT_RESEARCH,
  productStep,
  RESEARCH_ORDER,
  splitJobs,
  UPGRADES,
  type CorpConfig,
  type Job,
  type Purchase,
} from "../lib/plan/corp.js";

export interface CorpControl {
  /** may create the corporation ($150b) */
  allowCreate: boolean;
  /** the planner's current rep gap, for bribes with idle funds */
  bribeTarget?: { faction: string; repGap: number } | null;
  cfg?: Partial<CorpConfig>;
}

export interface CorpStatus {
  t: number;
  exists: boolean;
  funds: number;
  revenue: number;
  expenses: number;
  valuation: number;
  public: boolean;
  round: number;
  offer: number;
  dividendRate: number;
  divisions: string[];
  cities: number;
  employees: number;
  products: { name: string; progress: number; rating: number }[];
  /** cycles since the last growth purchase (drives dividends and bribes) */
  cyclesWithoutGrowth: number;
  /** your share of the corp, and the dividend tax exponent (dividends = x^(1 − tribute)) */
  ownership: number;
  tribute: number;
  bribed: number;
  last: string[];
  note: string;
}

const CORP_NAME = "Darxide Corp";
const CREATE_COST = 150e9;
const BOOST = [
  { name: "Hardware", key: "hardwareFactor" },
  { name: "Robots", key: "robotFactor" },
  { name: "AI Cores", key: "aiCoreFactor" },
  { name: "Real Estate", key: "realEstateFactor" },
] as const;

interface DivDef {
  name: string;
  industry: string;
  /** materials sold at MAX/MP */
  sells: string[];
  makesProducts: boolean;
  jobsFor: (city: string, cfg: CorpConfig) => Record<Job, number>;
  researchList: string[];
}
const AGRI: DivDef = {
  name: "Agri",
  industry: "Agriculture",
  sells: ["Plants", "Food"],
  makesProducts: false,
  jobsFor: (_c, cfg) => cfg.jobs,
  researchList: RESEARCH_ORDER,
};
const TOB: DivDef = {
  name: "Tob",
  industry: "Tobacco",
  sells: [],
  makesProducts: true,
  jobsFor: (c, cfg) => (c === DEV_CITY ? cfg.devJobs : cfg.rdJobs),
  researchList: [...RESEARCH_ORDER.slice(0, 3), ...PRODUCT_RESEARCH, ...RESEARCH_ORDER.slice(3)],
};
const PRODUCT_PREFIX = "Tob-";

interface CorpInfo {
  numShares: number;
  totalShares: number;
  tributeModifier: number;
  funds: number;
  revenue: number;
  expenses: number;
  valuation: number;
  public: boolean;
  divisions: string[];
  dividendRate: number;
}
interface DivInfo {
  cities: string[];
  researchPoints: number;
  products: string[];
  maxProducts: number;
}
interface OfficeInfo {
  size: number;
  numEmployees: number;
  avgEnergy: number;
  maxEnergy: number;
  avgMorale: number;
  maxMorale: number;
  employeeJobs: Record<string, number>;
}
interface WhInfo {
  size: number;
  sizeUsed: number;
}
interface MatInfo {
  stored: number;
  marketPrice: number;
  exports?: { division: string; city: string; amount: string }[];
}
interface ProductData {
  name: string;
  rating: number;
  developmentProgress: number;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const K = ns.corporation;
  const cc = <R>(fn: string, ...args: unknown[]) => call<R>(ns, `corporation.${fn}`, ...args);
  const ce = <R>(fn: string, lists: unknown[][]) => callEach<R>(ns, `corporation.${fn}`, lists);
  const log = (msg: string) => appendJsonl(ns, DATA.events, { t: Date.now(), kind: "corp", msg });
  const offers = new Map<number, number[]>();
  /** one-time setup done this session ("smart:div:city", "sell:div:city", "ta2:…", "prod:…") */
  const configured = new Set<string>();
  const boostMats = new Map<string, { name: string; factor: number; size: number }[]>();
  let cyclesWithoutGrowth = 0;
  let bribed = 0;
  /** consecutive cycles with revenue > expenses (investment rounds wait for a run of them) */
  let profitCycles = 0;

  while (true) {
    const ctl = readJson<CorpControl>(ns, DATA.corpConfig, { allowCreate: false });
    const cfg: CorpConfig = {
      ...DEFAULT_CORP,
      ...ctl.cfg,
      jobs: { ...DEFAULT_CORP.jobs, ...ctl.cfg?.jobs },
      devJobs: { ...DEFAULT_CORP.devJobs, ...ctl.cfg?.devJobs },
      rdJobs: { ...DEFAULT_CORP.rdJobs, ...ctl.cfg?.rdJobs },
    };
    const status: CorpStatus = {
      t: Date.now(),
      exists: K.hasCorporation(),
      funds: 0,
      revenue: 0,
      expenses: 0,
      valuation: 0,
      public: false,
      round: 0,
      offer: 0,
      dividendRate: 0,
      divisions: [],
      cities: 0,
      employees: 0,
      products: [],
      cyclesWithoutGrowth,
      ownership: 0,
      tribute: 0,
      bribed,
      last: [],
      note: "",
    };
    const did = (msg: string) => {
      status.last.push(msg);
      log(msg);
    };

    // ---- create ----
    if (!status.exists) {
      const check = K.canCreateCorporation(true);
      const cash = ns.getServerMoneyAvailable("home");
      if (check !== "Success") status.note = `can't create a corporation: ${check}`;
      else if (!ctl.allowCreate) status.note = "waiting for the daemon to allow creating one";
      else if (CREATE_COST > cash * cfg.createCashFrac)
        status.note = `waiting until $150b is ≤ ${cfg.createCashFrac * 100}% of cash`;
      else if (await cc<boolean>("createCorporation", CORP_NAME, true)) did(`created ${CORP_NAME}`);
      writeJson(ns, DATA.corp, status);
      await ns.sleep(30_000);
      continue;
    }

    // once per cycle, right after START
    if ((await K.nextUpdate()) !== "START") continue;
    try {
      await cycle();
    } catch (e) {
      status.note = `error: ${e instanceof Error ? e.message : String(e)}`;
    }
    writeJson(ns, DATA.corp, status);

    async function cycle() {
      let corp = (await cc<CorpInfo>("getCorporation"))!;
      const budget = () => corp.funds * cfg.budgetFrac;
      const refresh = async () => (corp = (await cc<CorpInfo>("getCorporation"))!);

      // ---- unlocks (Export once there are two divisions to connect) ----
      const unlocks = ["Warehouse API", "Office API", "Smart Supply", ...(corp.divisions.includes(TOB.name) ? ["Export"] : [])];
      const owned = new Set<string>();
      for (const u of unlocks) {
        if (await cc<boolean>("hasUnlock", u)) {
          owned.add(u);
          continue;
        }
        const cost = (await cc<number>("getUnlockCost", u)) ?? Infinity;
        if (cost <= corp.funds && (await cc("purchaseUnlock", u)) !== undefined) {
          did(`unlocked ${u}`);
          owned.add(u);
          await refresh();
        }
      }

      // ---- divisions: Agriculture first; Tobacco once Agriculture is complete and affordable ----
      const purchases: (Purchase & { act: unknown[] })[] = [];
      if (!corp.divisions.includes(AGRI.name)) {
        if (!(await startDivision(AGRI, 1))) return void (status.note = `saving for ${AGRI.industry}`);
      }
      const agri = await setupDivision(AGRI, purchases);
      if (!corp.divisions.includes(TOB.name) && agri.complete) await startDivision(TOB, cfg.productStartMult);
      const tob = corp.divisions.includes(TOB.name) ? await setupDivision(TOB, purchases) : null;
      status.divisions = corp.divisions.filter((d) => d === AGRI.name || d === TOB.name);

      // ---- Plants: Agriculture → Tobacco in every city both have, imports first ----
      if (tob && owned.has("Export")) {
        const both = agri.whCities.filter((c) => tob.whCities.includes(c));
        const plants = await ce<MatInfo>("getMaterial", both.map((c) => [AGRI.name, c, "Plants"]));
        const add = both.filter((c, k) => !(plants[k]?.exports ?? []).some((x) => x.division === TOB.name && x.city === c));
        await ce("exportMaterial", add.map((c) => [AGRI.name, c, TOB.name, c, "Plants", EXPORT_AMOUNT]));
        if (add.length) did(`exporting Plants to Tobacco in ${add.join(", ")}`);
        const opt = both.filter((c) => !configured.has(`imports:${c}`));
        await ce("setSmartSupplyOption", opt.map((c) => [TOB.name, c, "Plants", "imports"]));
        opt.forEach((c) => configured.add(`imports:${c}`));
      }

      // ---- products: develop in Aevum, retire the weakest when full, sell everywhere ----
      if (tob && tob.cities.includes(DEV_CITY)) {
        const div = (await cc<DivInfo>("getDivision", TOB.name))!;
        const data = (await ce<ProductData>("getProduct", div.products.map((p) => [TOB.name, DEV_CITY, p]))) as ProductData[];
        const products = data.filter(Boolean).map((p) => ({ name: p.name, progress: p.developmentProgress, rating: p.rating }));
        status.products = products;
        const step = productStep(products, div.maxProducts, PRODUCT_PREFIX);
        if (step.kind === "make") {
          const invest = Math.max(1e9, corp.funds * cfg.productInvestFrac);
          if (2 * invest <= corp.funds) {
            if (step.discontinue) {
              await cc("discontinueProduct", TOB.name, step.discontinue);
              did(`retired ${step.discontinue}`);
            }
            await cc("makeProduct", TOB.name, DEV_CITY, step.name, invest, invest);
            did(`designing ${step.name} ($${ns.format.number(2 * invest)})`);
            await refresh();
          }
        }
        const ta2 = await cc<boolean>("hasResearched", TOB.name, "Market-TA.II");
        for (const p of products.filter((x) => x.progress >= 100)) {
          if (!configured.has(`prod:${p.name}`)) {
            await cc("sellProduct", TOB.name, DEV_CITY, p.name, "MAX", "MP", true);
            configured.add(`prod:${p.name}`);
          }
          if (ta2 && !configured.has(`prodta2:${p.name}`)) {
            await cc("setProductMarketTA2", TOB.name, p.name, true);
            configured.add(`prodta2:${p.name}`);
          }
        }
      }

      // ---- corp-wide upgrades join the division purchases; buy the cheapest in budget ----
      const uCosts = await ce<number>("getUpgradeLevelCost", UPGRADES.map((u) => [u]));
      UPGRADES.forEach((u, k) => purchases.push({ what: u, cost: uCosts[k] ?? Infinity, act: ["levelUpgrade", u] }));
      const pick = cheapest(purchases, budget());
      if (pick) {
        const [fn, ...args] = (pick as (typeof purchases)[number]).act as [string, ...unknown[]];
        await cc(fn, ...args);
        did(`bought ${pick.what} ($${ns.format.number(pick.cost)})`);
        cyclesWithoutGrowth = 0;
        await refresh();
      } else cyclesWithoutGrowth++;
      status.cyclesWithoutGrowth = cyclesWithoutGrowth;

      // ---- investors, then public + dividends (rate from whether growth is still affordable) ----
      profitCycles = corp.revenue > corp.expenses ? profitCycles + 1 : 0;
      if (!corp.public) {
        const offer = await cc<{ funds: number; round: number }>("getInvestmentOffer");
        status.round = offer?.round ?? 0;
        status.offer = offer?.funds ?? 0;
        if (offer && offer.round <= cfg.maxRound) {
          // the offer only counts while the corp has been profitable for a while
          const h = profitCycles >= cfg.minProfitCycles ? [...(offers.get(offer.round) ?? []), offer.funds].slice(-100) : [];
          offers.set(offer.round, h);
          if (offerPlateaued(h, cfg) && (await cc<boolean>("acceptInvestmentOffer"))) {
            did(`accepted investment round ${offer.round}: $${ns.format.number(offer.funds)}`);
            offers.delete(offer.round);
          }
        } else if (offer && corp.revenue > corp.expenses && (await cc<boolean>("goPublic", 0))) {
          did("went public (no shares sold)");
          await cc("issueDividends", dividendFor(cyclesWithoutGrowth, cfg));
        }
      } else {
        const rate = dividendFor(cyclesWithoutGrowth, cfg);
        if (Math.abs(corp.dividendRate - rate) > 1e-9) {
          await cc("issueDividends", rate);
          did(`dividends set to ${rate * 100}% (${cyclesWithoutGrowth >= cfg.saturatedCycles ? "saturated" : "still growing"})`);
        }
      }

      // ---- bribes: idle funds → the planner's rep gap ----
      const target = ctl.bribeTarget;
      if (target) {
        const consts = K.getConstants();
        const amount = bribeAmount(target.repGap, corp.funds, corp.valuation, cyclesWithoutGrowth, consts, cfg);
        if (amount > 0 && (await cc<boolean>("bribe", target.faction, amount))) {
          bribed += amount;
          did(`bribed ${target.faction}: $${ns.format.number(amount)} → ${ns.format.number(amount / consts.bribeAmountPerReputation)} rep`);
        }
      }
      status.bribed = bribed;

      await refresh();
      Object.assign(status, {
        funds: corp.funds,
        revenue: corp.revenue,
        expenses: corp.expenses,
        valuation: corp.valuation,
        public: corp.public,
        dividendRate: corp.dividendRate,
        ownership: corp.totalShares > 0 ? corp.numShares / corp.totalShares : 0,
        tribute: corp.tributeModifier ?? 0,
      });

      // ---------- helpers (closures over corp/cfg/status) ----------

      /** Start a division once funds ≥ mult × its starting cost. */
      async function startDivision(d: DivDef, mult: number): Promise<boolean> {
        const ind = await cc<{ startingCost: number }>("getIndustryData", d.industry);
        if ((ind?.startingCost ?? Infinity) * mult > corp.funds) return false;
        await cc("expandIndustry", d.industry, d.name);
        did(`started ${d.industry} division ${d.name}`);
        await refresh();
        return true;
      }

      /**
       * Cities, warehouses, Smart Supply, sell orders, offices, boosts and research for one
       * division; pushes its growth purchases. `complete` = all six cities with warehouses.
       */
      async function setupDivision(d: DivDef, out: (Purchase & { act: unknown[] })[]) {
        let div = (await cc<DivInfo>("getDivision", d.name))!;
        const missing = CITIES.filter((c) => !div.cities.includes(c));
        if (missing.length && K.getConstants().officeInitialCost <= corp.funds) {
          await cc("expandCity", d.name, missing[0]);
          did(`${d.name}: opened an office in ${missing[0]}`);
          div = (await cc<DivInfo>("getDivision", d.name))!;
          await refresh();
        }
        const cities = div.cities;
        status.cities += cities.length;
        const has = await ce<boolean>("hasWarehouse", cities.map((c) => [d.name, c]));
        for (const [k, c] of cities.entries()) {
          if (has[k]) continue;
          if (K.getConstants().warehouseInitialCost > corp.funds) break;
          await cc("purchaseWarehouse", d.name, c);
          did(`${d.name}: bought a warehouse in ${c}`);
          has[k] = true;
          await refresh();
        }
        const wc = cities.filter((_, k) => has[k]);

        // one-time city setup
        const fresh = (tag: string) => wc.filter((c) => !configured.has(`${tag}:${d.name}:${c}`));
        if (await cc<boolean>("hasUnlock", "Smart Supply")) {
          const todo = fresh("smart");
          await ce("setSmartSupply", todo.map((c) => [d.name, c, true]));
          todo.forEach((c) => configured.add(`smart:${d.name}:${c}`));
        }
        const sellTodo = fresh("sell");
        await ce("sellMaterial", sellTodo.flatMap((c) => d.sells.map((m) => [d.name, c, m, "MAX", "MP"])));
        sellTodo.forEach((c) => configured.add(`sell:${d.name}:${c}`));

        // offices: tea/parties, hiring, jobs
        const offices = (await ce<OfficeInfo>("getOffice", cities.map((c) => [d.name, c]))) as OfficeInfo[];
        const autoBrew = await cc<boolean>("hasResearched", d.name, "AutoBrew");
        const autoParty = await cc<boolean>("hasResearched", d.name, "AutoPartyManager");
        const tea: unknown[][] = [];
        const party: unknown[][] = [];
        const hires: unknown[][] = [];
        const assign: unknown[][] = [];
        cities.forEach((c, k) => {
          const o = offices[k];
          if (!o) return;
          status.employees += o.numEmployees;
          if (!autoBrew && o.avgEnergy < o.maxEnergy * cfg.minEnergy) tea.push([d.name, c]);
          if (!autoParty && o.avgMorale < o.maxMorale * cfg.minMorale) party.push([d.name, c, 500e3]);
          for (let i = o.numEmployees; i < o.size; i++) hires.push([d.name, c, "Unassigned"]);
          const want = splitJobs(o.size, d.jobsFor(c, cfg));
          if (JOBS.some((j) => (o.employeeJobs[j] ?? 0) !== want[j])) {
            for (const j of JOBS) assign.push([d.name, c, j, 0]);
            for (const j of JOBS) assign.push([d.name, c, j, want[j]]);
          }
        });
        await ce("buyTea", tea);
        await ce("throwParty", party);
        await ce("hireEmployee", hires);
        if (hires.length) did(`${d.name}: hired ${hires.length} employee(s)`);
        await ce("setJobAssignment", assign);

        // boost materials: the optimal mix for this industry in `boostFrac` of each warehouse
        if (!boostMats.has(d.name)) {
          const ind = (await cc<Record<string, number>>("getIndustryData", d.industry)) ?? {};
          const sizes = await ce<{ size: number }>("getMaterialData", BOOST.map((b) => [b.name]));
          boostMats.set(d.name, BOOST.map((b, k) => ({ name: b.name, factor: ind[b.key] ?? 0, size: sizes[k]?.size ?? 0 })));
        }
        const mats = boostMats.get(d.name)!;
        const whs = (await ce<WhInfo>("getWarehouse", wc.map((c) => [d.name, c]))) as WhInfo[];
        const stock = await ce<MatInfo>("getMaterial", wc.flatMap((c) => mats.map((b) => [d.name, c, b.name])));
        const buys: unknown[][] = [];
        let spend = 0;
        wc.forEach((c, k) => {
          const target = optimalBoost(mats, (whs[k]?.size ?? 0) * cfg.boostFrac);
          mats.forEach((b, j) => {
            const m = stock[k * mats.length + j];
            const need = Math.floor((target[b.name] ?? 0) - (m?.stored ?? 0));
            if (need <= 0 || !m) return;
            const cost = need * m.marketPrice;
            if (spend + cost > budget()) return;
            spend += cost;
            buys.push([d.name, c, b.name, need]);
          });
        });
        await ce("bulkPurchase", buys);
        if (buys.length) did(`${d.name}: bought boost materials ($${ns.format.number(spend)})`);
        await refresh();

        // research, in order
        for (const r of d.researchList) {
          if (await cc<boolean>("hasResearched", d.name, r)) continue;
          const cost = (await cc<number>("getResearchCost", d.name, r)) ?? Infinity;
          if (cost <= div.researchPoints / 2) {
            await cc("research", d.name, r);
            did(`${d.name}: researched ${r}`);
          }
          break;
        }
        if (d.sells.length && (await cc<boolean>("hasResearched", d.name, "Market-TA.II"))) {
          const todo = fresh("ta2");
          await ce("setMaterialMarketTA2", todo.flatMap((c) => d.sells.map((m) => [d.name, c, m, true])));
          todo.forEach((c) => configured.add(`ta2:${d.name}:${c}`));
        }

        // growth purchases
        const wCosts = await ce<number>("getUpgradeWarehouseCost", wc.map((c) => [d.name, c, 1]));
        wc.forEach((c, k) => {
          const w = whs[k];
          if (w && w.sizeUsed / w.size > cfg.warehouseFull)
            out.push({ what: `${d.name} warehouse ${c}`, cost: wCosts[k] ?? Infinity, act: ["upgradeWarehouse", d.name, c, 1] });
        });
        const oCosts = await ce<number>("getOfficeSizeUpgradeCost", cities.map((c) => [d.name, c, 3]));
        cities.forEach((c, k) => out.push({ what: `${d.name} office ${c} +3`, cost: oCosts[k] ?? Infinity, act: ["upgradeOfficeSize", d.name, c, 3] }));
        out.push({ what: `${d.name} AdVert`, cost: (await cc<number>("getHireAdVertCost", d.name)) ?? Infinity, act: ["hireAdVert", d.name] });

        return { cities, whCities: wc, complete: wc.length === CITIES.length };
      }
    }
  }
}
