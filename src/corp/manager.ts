// Corporation manager (decisions in lib/plan/corp.ts). Every corporation function costs
// 10–20 GB, so all of them go through the call proxy (lib/call.ts): one temporary script
// per function, peak ~22 GB. Function names only appear inside strings here, and local
// names avoid corp API names, so this script itself stays tiny (see README "RAM model").
//
// Once per corp cycle: unlocks → Agriculture division in all six cities → warehouses,
// Smart Supply, sell orders → offices (hire, job split, tea/parties) → optimal boost
// materials → research → the cheapest affordable upgrade → investment rounds (accepted
// when the offer plateaus) → go public and pay dividends.
// Steered by data/corp-config.txt from the daemon; status in data/corp.txt.
import type { NS } from "@ns";
import { call, callEach } from "../lib/call.js";
import { appendJsonl, readJson, writeJson } from "../lib/io.js";
import { DATA } from "../lib/paths.js";
import {
  CITIES,
  cheapest,
  DEFAULT_CORP,
  JOBS,
  offerPlateaued,
  optimalBoost,
  RESEARCH_ORDER,
  splitJobs,
  UPGRADES,
  type CorpConfig,
  type Purchase,
} from "../lib/plan/corp.js";

export interface CorpControl {
  /** may create the corporation ($150b) */
  allowCreate: boolean;
  cfg?: Partial<CorpConfig>;
}

export interface CorpStatus {
  t: number;
  exists: boolean;
  funds: number;
  revenue: number;
  expenses: number;
  public: boolean;
  round: number;
  offer: number;
  dividendRate: number;
  cities: number;
  employees: number;
  last: string[];
  note: string;
}

const DIV = "Agri";
const INDUSTRY = "Agriculture";
const CORP_NAME = "Darxide Corp";
const CREATE_COST = 150e9;
const SELLS = ["Plants", "Food"];
const BOOST = [
  { name: "Hardware", key: "hardwareFactor" },
  { name: "Robots", key: "robotFactor" },
  { name: "AI Cores", key: "aiCoreFactor" },
  { name: "Real Estate", key: "realEstateFactor" },
] as const;

interface CorpInfo {
  funds: number;
  revenue: number;
  expenses: number;
  public: boolean;
  divisions: string[];
  dividendRate: number;
}
interface DivInfo {
  cities: string[];
  researchPoints: number;
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
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const K = ns.corporation;
  const cc = <R>(fn: string, ...args: unknown[]) => call<R>(ns, `corporation.${fn}`, ...args);
  const ce = <R>(fn: string, lists: unknown[][]) => callEach<R>(ns, `corporation.${fn}`, lists);
  const log = (msg: string) => appendJsonl(ns, DATA.events, { t: Date.now(), kind: "corp", msg });
  const offers = new Map<number, number[]>();
  const configured = new Set<string>(); // "smart:city", "sell:city", "ta2:city"
  let boostMats: { name: string; factor: number; size: number }[] | null = null;

  while (true) {
    const ctl = readJson<CorpControl>(ns, DATA.corpConfig, { allowCreate: false });
    const cfg: CorpConfig = { ...DEFAULT_CORP, ...ctl.cfg, jobs: { ...DEFAULT_CORP.jobs, ...ctl.cfg?.jobs } };
    const status: CorpStatus = {
      t: Date.now(),
      exists: K.hasCorporation(),
      funds: 0,
      revenue: 0,
      expenses: 0,
      public: false,
      round: 0,
      offer: 0,
      dividendRate: 0,
      cities: 0,
      employees: 0,
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

      // ---- unlocks ----
      for (const u of ["Warehouse API", "Office API", "Smart Supply"]) {
        if (await cc<boolean>("hasUnlock", u)) continue;
        const cost = (await cc<number>("getUnlockCost", u)) ?? Infinity;
        if (cost <= corp.funds && (await cc("purchaseUnlock", u)) !== undefined) {
          did(`unlocked ${u}`);
          await refresh();
        }
      }
      const smart = await cc<boolean>("hasUnlock", "Smart Supply");

      // ---- division and cities ----
      if (!corp.divisions.includes(DIV)) {
        const data = await cc<{ startingCost: number }>("getIndustryData", INDUSTRY);
        if ((data?.startingCost ?? Infinity) > corp.funds) return void (status.note = `saving for ${INDUSTRY}`);
        await cc("expandIndustry", INDUSTRY, DIV);
        did(`started ${INDUSTRY} division ${DIV}`);
        await refresh();
      }
      let div = (await cc<DivInfo>("getDivision", DIV))!;
      const missing = CITIES.filter((c) => !div.cities.includes(c));
      const officeCost = K.getConstants().officeInitialCost;
      if (missing.length && officeCost <= corp.funds) {
        await cc("expandCity", DIV, missing[0]);
        did(`opened an office in ${missing[0]}`);
        div = (await cc<DivInfo>("getDivision", DIV))!;
        await refresh();
      }
      const cities = div.cities;
      status.cities = cities.length;
      const has = await ce<boolean>("hasWarehouse", cities.map((c) => [DIV, c]));
      for (const [k, c] of cities.entries()) {
        if (has[k]) continue;
        if (K.getConstants().warehouseInitialCost > corp.funds) break;
        await cc("purchaseWarehouse", DIV, c);
        did(`bought a warehouse in ${c}`);
        has[k] = true;
        await refresh();
      }
      const wc = cities.filter((_, k) => has[k]);

      // ---- one-time city setup: Smart Supply, sell orders ----
      const fresh = (tag: string) => wc.filter((c) => !configured.has(`${tag}:${c}`));
      if (smart) {
        const todo = fresh("smart");
        await ce("setSmartSupply", todo.map((c) => [DIV, c, true]));
        todo.forEach((c) => configured.add(`smart:${c}`));
      }
      const sellTodo = fresh("sell");
      await ce("sellMaterial", sellTodo.flatMap((c) => SELLS.map((m) => [DIV, c, m, "MAX", "MP"])));
      sellTodo.forEach((c) => configured.add(`sell:${c}`));

      // ---- offices: tea/parties, hiring, jobs ----
      const offices = (await ce<OfficeInfo>("getOffice", cities.map((c) => [DIV, c]))) as OfficeInfo[];
      const autoBrew = await cc<boolean>("hasResearched", DIV, "AutoBrew");
      const autoParty = await cc<boolean>("hasResearched", DIV, "AutoPartyManager");
      const tea: unknown[][] = [];
      const party: unknown[][] = [];
      const hires: unknown[][] = [];
      const assign: unknown[][] = [];
      cities.forEach((c, k) => {
        const o = offices[k];
        if (!o) return;
        status.employees += o.numEmployees;
        if (!autoBrew && o.avgEnergy < o.maxEnergy * cfg.minEnergy) tea.push([DIV, c]);
        if (!autoParty && o.avgMorale < o.maxMorale * cfg.minMorale) party.push([DIV, c, 500e3]);
        for (let i = o.numEmployees; i < o.size; i++) hires.push([DIV, c, "Unassigned"]);
        const want = splitJobs(o.size, cfg.jobs);
        if (JOBS.some((j) => (o.employeeJobs[j] ?? 0) !== want[j])) {
          for (const j of JOBS) assign.push([DIV, c, j, 0]);
          for (const j of JOBS) assign.push([DIV, c, j, want[j]]);
        }
      });
      await ce("buyTea", tea);
      await ce("throwParty", party);
      await ce("hireEmployee", hires);
      if (hires.length) did(`hired ${hires.length} employee(s)`);
      await ce("setJobAssignment", assign); // after hiring, so everyone exists

      // ---- boost materials (optimal mix for this industry, `boostFrac` of each warehouse) ----
      if (!boostMats) {
        const ind = (await cc<Record<string, number>>("getIndustryData", INDUSTRY)) ?? {};
        const sizes = await ce<{ size: number }>("getMaterialData", BOOST.map((b) => [b.name]));
        boostMats = BOOST.map((b, k) => ({ name: b.name, factor: ind[b.key] ?? 0, size: sizes[k]?.size ?? 0 }));
      }
      const whs = (await ce<WhInfo>("getWarehouse", wc.map((c) => [DIV, c]))) as WhInfo[];
      const mats = await ce<MatInfo>("getMaterial", wc.flatMap((c) => boostMats!.map((b) => [DIV, c, b.name])));
      const buys: unknown[][] = [];
      let spend = 0;
      wc.forEach((c, k) => {
        const target = optimalBoost(boostMats!, (whs[k]?.size ?? 0) * cfg.boostFrac);
        boostMats!.forEach((b, j) => {
          const m = mats[k * boostMats!.length + j];
          const need = Math.floor((target[b.name] ?? 0) - (m?.stored ?? 0));
          if (need <= 0 || !m) return;
          const cost = need * m.marketPrice;
          if (spend + cost > budget()) return;
          spend += cost;
          buys.push([DIV, c, b.name, need]);
        });
      });
      await ce("bulkPurchase", buys);
      if (buys.length) did(`bought boost materials ($${ns.format.number(spend)})`);
      await refresh();

      // ---- research ----
      for (const r of RESEARCH_ORDER) {
        if (await cc<boolean>("hasResearched", DIV, r)) continue;
        const cost = (await cc<number>("getResearchCost", DIV, r)) ?? Infinity;
        if (cost <= div.researchPoints / 2) {
          await cc("research", DIV, r);
          did(`researched ${r}`);
        }
        break; // in order: wait for the next one's points
      }
      if (await cc<boolean>("hasResearched", DIV, "Market-TA.II")) {
        const todo = fresh("ta2");
        await ce("setMaterialMarketTA2", todo.flatMap((c) => SELLS.map((m) => [DIV, c, m, true])));
        todo.forEach((c) => configured.add(`ta2:${c}`));
      }

      // ---- one purchase per cycle: the cheapest useful one within budget ----
      const opts: (Purchase & { act: unknown[] })[] = [];
      const wCosts = await ce<number>("getUpgradeWarehouseCost", wc.map((c) => [DIV, c, 1]));
      wc.forEach((c, k) => {
        const w = whs[k];
        if (w && w.sizeUsed / w.size > cfg.warehouseFull)
          opts.push({ what: `warehouse ${c}`, cost: wCosts[k] ?? Infinity, act: ["upgradeWarehouse", DIV, c, 1] });
      });
      const oCosts = await ce<number>("getOfficeSizeUpgradeCost", cities.map((c) => [DIV, c, 3]));
      cities.forEach((c, k) => opts.push({ what: `office ${c} +3`, cost: oCosts[k] ?? Infinity, act: ["upgradeOfficeSize", DIV, c, 3] }));
      const uCosts = await ce<number>("getUpgradeLevelCost", UPGRADES.map((u) => [u]));
      UPGRADES.forEach((u, k) => opts.push({ what: u, cost: uCosts[k] ?? Infinity, act: ["levelUpgrade", u] }));
      opts.push({ what: "AdVert", cost: (await cc<number>("getHireAdVertCost", DIV)) ?? Infinity, act: ["hireAdVert", DIV] });
      const pick = cheapest(opts, budget());
      if (pick) {
        const [fn, ...args] = (pick as (typeof opts)[number]).act as [string, ...unknown[]];
        await cc(fn, ...args);
        did(`bought ${pick.what} ($${ns.format.number(pick.cost)})`);
        await refresh();
      }

      // ---- investors, then public + dividends ----
      if (!corp.public) {
        const offer = await cc<{ funds: number; round: number }>("getInvestmentOffer");
        status.round = offer?.round ?? 0;
        status.offer = offer?.funds ?? 0;
        if (offer && offer.round <= cfg.maxRound) {
          const h = [...(offers.get(offer.round) ?? []), offer.funds].slice(-50);
          offers.set(offer.round, h);
          if (offerPlateaued(h, cfg) && (await cc<boolean>("acceptInvestmentOffer"))) {
            did(`accepted investment round ${offer.round}: $${ns.format.number(offer.funds)}`);
            offers.delete(offer.round);
          }
        } else if (offer && corp.revenue > corp.expenses && (await cc<boolean>("goPublic", 0))) {
          did("went public (no shares sold)");
          await cc("issueDividends", cfg.dividendRate);
        }
      } else if (Math.abs(corp.dividendRate - cfg.dividendRate) > 1e-9) {
        await cc("issueDividends", cfg.dividendRate);
        did(`dividends set to ${cfg.dividendRate * 100}%`);
      }

      await refresh();
      Object.assign(status, {
        funds: corp.funds,
        revenue: corp.revenue,
        expenses: corp.expenses,
        public: corp.public,
        dividendRate: corp.dividendRate,
      });
    }
  }
}
