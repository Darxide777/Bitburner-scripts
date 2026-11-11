// Hacknet manager: spends hashes on whatever is worth most per hash right now, and buys
// production (levels / RAM / cores / servers) by payback time (lib/plan/hacknet.ts).
// Steered by data/hacknet-config.txt from the daemon (buy: false while the casino bets).
// Status in data/hacknet.txt, including the *measured* effect of each upgrade bought.
import type { HacknetServerHashUpgrade, NS } from "@ns";
import { readJson, writeJson } from "../lib/io.js";
import { DATA } from "../lib/paths.js";
import {
  BB_RANK,
  chooseRamUpgrade,
  chooseUpgrade,
  CONTRACT,
  CORP_FUNDS,
  decideSpend,
  reachable,
  DEFAULT_HACKNET,
  expectedRunMs,
  MAX_MONEY,
  MIN_SEC,
  SELL,
  valueOptions,
  type HacknetConfig,
  type HashOption,
  type RamUpgrade,
  type ServerInfo,
  type Upgrade,
} from "../lib/plan/hacknet.js";

export interface HacknetControl {
  buy: boolean;
  cfg?: Partial<HacknetConfig>;
  /** Cash to keep for augs; production never spends below this. */
  reserve?: number;
  /** Absolute $ budget for this plan (share-only mode); tracked across ticks. */
  budget?: number;
  /** Buy only RAM/new servers, for share() threads instead of hash production. */
  shareRam?: boolean;
}

export interface HacknetStatus {
  t: number;
  servers: number;
  production: number;
  hashes: number;
  capacity: number;
  remainingSec: number;
  options: Pick<HashOption, "name" | "target" | "cost" | "perHash" | "why">[];
  decision: string;
  /** measured per-purchase effect (EMA): max-money ×, min-security × */
  measured: { maxMoneyGain: number | null; minSecMult: number | null };
  spent: Record<string, number>;
  bought: Record<string, number>;
  note: string;
}

const NAMES = [SELL, MAX_MONEY, MIN_SEC, BB_RANK, CONTRACT, CORP_FUNDS] as HacknetServerHashUpgrade[];

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const H = ns.hacknet;
  const measured: HacknetStatus["measured"] = { maxMoneyGain: null, minSecMult: null };
  const spent: Record<string, number> = {};
  const bought: Record<string, number> = {};
  const ema = (old: number | null, x: number) => (old === null ? x : old + 0.3 * (x - old));
  let budgetKey = "";
  let budgetSpent = 0;

  while (true) {
    await ns.sleep(2000);
    const ctl = readJson<HacknetControl>(ns, DATA.hacknetConfig, { buy: false });
    const cfg: HacknetConfig = { ...DEFAULT_HACKNET, ...ctl.cfg };
    const nextBudgetKey = `${ctl.budget ?? "f"}:${ctl.reserve ?? 0}:${ctl.shareRam ?? false}`;
    if (nextBudgetKey !== budgetKey) {
      budgetKey = nextBudgetKey;
      budgetSpent = 0;
    }
    const n = H.numNodes();
    const capacity = H.hashCapacity();
    const status: HacknetStatus = {
      t: Date.now(),
      servers: n,
      production: 0,
      hashes: H.numHashes(),
      capacity,
      remainingSec: 0,
      options: [],
      decision: "",
      measured,
      spent,
      bought,
      note: "",
    };
    if (n > 0 && capacity <= 0) {
      status.note = "hacknet nodes, not servers (needs SF9): nothing to manage";
      writeJson(ns, DATA.hacknet, status);
      await ns.sleep(60_000);
      continue;
    }

    // ---- data the valuation needs ----
    const st = readJson<{ metrics?: { long?: { income?: number; bySource?: Record<string, number> }; sinceInstall?: number } }>(ns, DATA.status, {});
    const corp = readJson<{ t?: number; exists?: boolean; revenue?: number; expenses?: number; valuation?: number; tribute?: number }>(ns, DATA.corp, {});
    const since = (st.metrics?.sinceInstall ?? 0) / 1000;
    const runs = ns
      .read(DATA.runs)
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { durationMs?: number }).durationMs ?? 0);
    const remainingSec = Math.max(cfg.minRemainingSec, expectedRunMs(runs, 30 * 60_000) / 1000 - since);
    status.remainingSec = remainingSec;
    const hackStatus = readJson<{ targets?: { host: string; ratePerSec: number }[] }>(ns, DATA.hackStatus, {});
    const targets = (hackStatus.targets ?? []).map((t) => ({
      host: t.host,
      ratePerSec: t.ratePerSec,
      minSecurity: ns.getServerMinSecurityLevel(t.host),
      reqHack: ns.getServerRequiredHackingLevel(t.host),
    }));
    const bb = readJson<{ inDivision?: boolean; blackOpsDone?: boolean; rank?: number; rankPerSec?: number; finalRank?: number; t?: number }>(ns, DATA.bladeburner, {});
    const contracts = readJson<{ moneyRewards?: number[] }>(ns, DATA.contracts, {});
    const costs: Record<string, number> = {};
    for (const name of NAMES) costs[name] = H.hashCost(name);

    const options = valueOptions(
      {
        remainingSec,
        incomePerSec: st.metrics?.long?.income ?? 0,
        targets,
        costs,
        maxMoneyGain: measured.maxMoneyGain ?? undefined,
        minSecMult: measured.minSecMult ?? undefined,
        bladeburner:
          bb.inDivision && !bb.blackOpsDone && bb.t && Date.now() - bb.t < 120_000
            ? { rank: bb.rank ?? 0, rankPerSec: bb.rankPerSec ?? 0, finalRank: bb.finalRank ?? 0, active: true }
            : null,
        contractRewards: contracts.moneyRewards,
        corp:
          corp.exists && corp.t && Date.now() - corp.t < 120_000
            ? {
                profitPerSec: (corp.revenue ?? 0) - (corp.expenses ?? 0),
                valuation: corp.valuation ?? 0,
                realizedPerSec: st.metrics?.long?.bySource?.corporation ?? 0,
                tribute: corp.tribute ?? 0,
              }
            : null,
      },
      cfg,
    );
    status.options = options.slice(0, 6).map(({ name, target, cost, perHash, why }) => ({ name, target, cost, perHash, why }));

    // ---- production ----
    const servers: ServerInfo[] = [];
    for (let i = 0; i < n; i++) {
      const s = H.getNodeStats(i);
      servers.push({ level: s.level, ram: s.ram, cores: s.cores, production: s.production });
      status.production += s.production;
    }
    // ---- spend hashes (a few purchases per tick) ----
    for (let k = 0; k < 20; k++) {
      const d = decideSpend(options, H.numHashes(), capacity, status.production, remainingSec);
      if (!d) break;
      if (d.kind === "save") {
        status.decision = `saving for ${d.option.name}${d.option.target ? ` on ${d.option.target}` : ""} (${Math.floor(H.numHashes())}/${Math.ceil(d.option.cost)})`;
        break;
      }
      if (d.kind === "sell") {
        if (H.spendHashes(SELL as HacknetServerHashUpgrade, "", d.count)) {
          spent[SELL] = (spent[SELL] ?? 0) + d.count;
          status.decision = `sold ${d.count}× for money`;
        }
        break;
      }
      const o = d.option;
      const before =
        o.name === MAX_MONEY ? ns.getServerMaxMoney(o.target!) : o.name === MIN_SEC ? ns.getServerMinSecurityLevel(o.target!) : 0;
      if (!H.spendHashes(o.name as HacknetServerHashUpgrade, o.target ?? "")) break;
      spent[o.name] = (spent[o.name] ?? 0) + 1;
      status.decision = `bought ${o.name}${o.target ? ` on ${o.target}` : ""} (${o.why})`;
      if (o.name === MAX_MONEY && before > 0) measured.maxMoneyGain = ema(measured.maxMoneyGain, ns.getServerMaxMoney(o.target!) / before);
      if (o.name === MIN_SEC && before > 0) measured.minSecMult = ema(measured.minSecMult, ns.getServerMinSecurityLevel(o.target!) / before);
      // prices rise with each purchase: re-price before the next one
      costs[o.name] = H.hashCost(o.name as HacknetServerHashUpgrade);
      o.cost = costs[o.name];
      o.perHash = o.value / o.cost;
      options.sort((a, b) => b.perHash - a.perHash);
    }

    const reserve = Math.max(0, ctl.reserve ?? 0);
    const budgetNow = () => {
      const surplus = Math.max(0, ns.getServerMoneyAvailable("home") - reserve);
      return ctl.budget != null ? Math.min(surplus, Math.max(0, ctl.budget - budgetSpent)) : surplus * cfg.budgetFrac;
    };
    const costOf = (u: { kind: string; index: number }) =>
      u.kind === "level"
        ? H.getLevelUpgradeCost(u.index, 1)
        : u.kind === "ram"
          ? H.getRamUpgradeCost(u.index, 1)
          : u.kind === "cores"
            ? H.getCoreUpgradeCost(u.index, 1)
            : H.numNodes() < H.maxNumNodes()
              ? H.getPurchaseNodeCost()
              : Infinity;
    const purchase = (u: Upgrade | RamUpgrade) => {
      const ok =
        u.kind === "level"
          ? H.upgradeLevel(u.index, 1)
          : u.kind === "ram"
            ? H.upgradeRam(u.index, 1)
            : u.kind === "cores"
              ? H.upgradeCore(u.index, 1)
              : H.purchaseNode() >= 0;
      if (!ok) return false;
      budgetSpent += u.cost;
      bought[u.kind] = (bought[u.kind] ?? 0) + 1;
      if (u.kind === "server") servers.push({ level: 1, ram: 1, cores: 1, production: 0 });
      else {
        const s = H.getNodeStats(u.index);
        servers[u.index] = { level: s.level, ram: s.ram, cores: s.cores, production: s.production };
      }
      return true;
    };

    if (!ctl.buy) status.note = ctl.shareRam ? "not buying: economy.js is buying share RAM" : "not buying (cash reserved)";
    else if (!ctl.shareRam && !ns.fileExists("Formulas.exe", "home")) status.note = "no Formulas.exe: not buying production yet";
    else if (ctl.shareRam) {
      status.note = "share-only: buying RAM/servers for share()";
      for (let k = 0; k < 10; k++) {
        const u = chooseRamUpgrade(servers, costOf, budgetNow());
        if (!u || !purchase(u)) break;
      }
    } else {
      const F = ns.formulas.hacknetServers;
      const rate = (level: number, ram: number, cores: number) => F.hashGainRate(level, 0, ram, cores, 1);
      const hashValue = Math.max(...options.map((o) => o.perHash), 250_000);
      const fallbackMult = ns.getPlayer().mults.hacknet_node_money;
      for (let k = 0; k < 10; k++) {
        const u = chooseUpgrade(servers, rate, costOf, hashValue, remainingSec, budgetNow(), cfg, fallbackMult);
        if (!u || !purchase(u)) break;
      }
      // the best non-sell option no longer fits the cache: grow the cache (cheapest server first)
      const sellPer = options.find((x) => x.name === SELL)?.perHash ?? 0;
      const want = options.find((o) => o.name !== SELL && o.perHash > sellPer && reachable(o, status.hashes, status.production, remainingSec));
      if (want && want.cost > capacity && n > 0) {
        let best = 0;
        for (let i = 1; i < n; i++) if (H.getCacheUpgradeCost(i, 1) < H.getCacheUpgradeCost(best, 1)) best = i;
        const cost = H.getCacheUpgradeCost(best, 1);
        if (cost <= budgetNow() && H.upgradeCache(best, 1)) {
          budgetSpent += cost;
          bought.cache = (bought.cache ?? 0) + 1;
        }
      }
    }
    writeJson(ns, DATA.hacknet, status);
  }
}
