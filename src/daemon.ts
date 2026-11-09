// The orchestrator. Start it with `run daemon.js` — it is the only script you run.
//
// Kept deliberately cheap in RAM: anything expensive (Singularity, Gang, ...)
// happens in tasks/*.js run on demand. Each tick it:
//   - roots everything it can
//   - takes a telemetry snapshot → rolling metrics (income/s, rep/s, karma/s, ETAs)
//   - keeps the hacking manager running and steers it via data/hack-config.txt
//   - runs planner modules on their own cadence (economy, ...)
//   - writes data/status.txt, appends data/metrics.txt every minute,
//     logs decisions to data/events.txt and one line per reset to data/runs.txt
//   - draws a dashboard in its tail window
import type { NS } from "@ns";
import { dur, money, num, pad, ram } from "./lib/fmt.js";
import { appendJsonl, readJson, writeJson } from "./lib/io.js";
import { MetricsTracker, type Metrics } from "./lib/metrics.js";
import { allHosts, portOpenerCount, rootAll } from "./lib/net.js";
import { BUILD_MARKER, DATA, GANG_KARMA, SCRIPTS } from "./lib/paths.js";
import { call } from "./lib/call.js";
import { collectFactionData } from "./lib/plan/collect.js";
import { NFG, type FactionData } from "./lib/plan/data.js";
import { augValue, DEFAULT_PLAN, plan as makePlan, type Plan, type PlanConfig } from "./lib/plan/factions.js";
import type { GangConfig } from "./lib/plan/gang.js";
import type { GoConfig } from "./lib/plan/go.js";
import { manageSleeves } from "./lib/sleeves.js";
import { DEFAULT_STANEK, manageStanek, type StanekConfig, type StanekStatus } from "./lib/stanek.js";
import { runTask, spawnTask } from "./lib/task.js";
import type { Snapshot } from "./lib/types.js";
import type { HackConfig } from "./hack/manager.js";
import type { ActArgs } from "./tasks/factions-act.js";
import type { BladeburnerControl, BladeburnerStatus } from "./bladeburner/manager.js";
import type { BbConfig } from "./lib/plan/bladeburner.js";
import { DEFAULT_RECOVERY, type RecoveryConfig } from "./lib/plan/sleeves.js";
import { DEFAULT_STOCKS, type StockConfig } from "./lib/plan/stocks.js";
import type { StocksControl, StocksStatus } from "./stocks/manager.js";
import type { HacknetControl, HacknetStatus } from "./hacknet/manager.js";
import type { HacknetConfig } from "./lib/plan/hacknet.js";

interface DaemonConfig {
  tickMs: number;
  /** Fraction of current money the economy module may spend per run (null = let the planner decide). */
  infraSpend: number | null;
  economyEveryMs: number;
  factionsEveryMs: number;
  /** Overrides for the faction/augment planner (see lib/plan/factions.ts DEFAULT_PLAN). */
  plan: Partial<PlanConfig>;
  manageSleeves: boolean;
  manageGang: boolean;
  /** Auto-run casino.js early in a run (see casinoModule). */
  casino: boolean;
  /** Overrides for Stanek's Gift management (see lib/stanek.ts DEFAULT_STANEK). */
  stanek: Partial<StanekConfig>;
  /** Overrides for the IPvGO manager (see lib/plan/go.ts DEFAULT_GO). */
  go: Partial<GoConfig>;
  /** Overrides for the gang manager (see lib/plan/gang.ts DEFAULT_GANG); mode is set automatically unless given. */
  gang: Partial<GangConfig>;
  /** Solve coding contracts (tasks/contracts.js) every contractsEveryMs. */
  manageContracts: boolean;
  contractsEveryMs: number;
  /** Trade stocks with 4S data (stocks/manager.js, ~37 GB) once home has stocksMinHomeGB. */
  /** Hacknet servers: spend hashes by value, buy production by payback (hacknet/manager.js). */
  manageHacknet: boolean;
  hacknet: Partial<HacknetConfig>;
  manageStocks: boolean;
  stocks: Partial<StockConfig>;
  stocksMinHomeGB: number;
  /** Sleeve shock-recovery rotation (see lib/plan/sleeves.ts DEFAULT_RECOVERY). */
  sleeveRecovery: Partial<RecoveryConfig>;
  manageBladeburner: boolean;
  /** Overrides for Bladeburner decisions (see lib/plan/bladeburner.ts DEFAULT_BB). */
  bladeburner: Partial<BbConfig>;
  /** Home RAM needed before the (~70 GB) Bladeburner manager runs. */
  bladeburnerMinHomeGB: number;
}
const DEFAULTS: DaemonConfig = {
  tickMs: 2000,
  infraSpend: null,
  economyEveryMs: 10_000,
  factionsEveryMs: 15_000,
  plan: {},
  manageSleeves: true,
  manageGang: true,
  casino: true,
  stanek: {},
  go: {},
  gang: {},
  manageContracts: true,
  contractsEveryMs: 5 * 60_000,
  manageHacknet: true,
  hacknet: {},
  manageStocks: true,
  stocks: {},
  stocksMinHomeGB: 512,
  sleeveRecovery: {},
  manageBladeburner: true,
  bladeburner: {},
  bladeburnerMinHomeGB: 512,
};

interface DaemonState {
  lastAugReset: number;
  lastNodeReset: number;
  installs: number;
  /** Peak values of the run in progress, summarized into data/runs.txt on reset. */
  cur: { start: number; peakIncome: number; peakRepRate: number; hackLevel: number; augsInstalled: number };
}

const STATE_FILE = "data/daemon-state.txt";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  ns.ui.openTail();
  ns.ui.setTailTitle("Bitburner automation");

  const tracker = new MetricsTracker();
  const recent: string[] = [];
  let lastEconomy = 0;
  let lastFactions = 0;
  let lastMetricsLine = 0;
  let lastContracts = 0;
  let selftestStarted = false;
  let current: Plan | null = null;
  let lastNotes = "";
  let lastError = "";

  const event = (kind: string, msg: string, data?: unknown) => {
    appendJsonl(ns, DATA.events, { t: Date.now(), kind, msg, data }, 3000);
    recent.unshift(`${new Date().toLocaleTimeString()} ${msg}`);
    recent.length = Math.min(recent.length, 8);
  };

  event("start", "daemon started");
  const build = ns.read(BUILD_MARKER);

  while (true) {
    // ---- new build pushed by tools/sync.mjs → restart on it ----
    const nextBuild = ns.read(BUILD_MARKER);
    if (nextBuild !== build && spawnTask(ns, SCRIPTS.restart)) {
      event("start", `new build ${nextBuild}: restarting`);
      return;
    }
    const cfg: DaemonConfig = { ...DEFAULTS, ...readJson<Partial<DaemonConfig>>(ns, DATA.config, {}) };

    // ---- root ----
    const fresh = rootAll(ns, allHosts(ns));
    if (fresh.length) event("root", `rooted ${fresh.join(", ")}`);

    // ---- telemetry ----
    const snap = await runTask<Snapshot>(ns, "tasks/snapshot.js");
    if (snap.ok && snap.value) {
      tracker.push(snap.value);
      trackRuns(ns, snap.value, tracker, event);
    } else if (snap.error !== lastError) {
      lastError = snap.error ?? "";
      event("error", `snapshot failed: ${snap.error}`);
    }
    const s = tracker.latest();
    const m = tracker.metrics();

    // ---- casino ($10b per install, early in a run) ----
    if (s && cfg.casino) casinoModule(ns, s, m, event);

    // ---- IPvGO manager ----
    if (cfg.go.enabled !== false) {
      writeJson(ns, DATA.goConfig, cfg.go);
      if (!ns.isRunning(SCRIPTS.goManager, "home") && ns.exec(SCRIPTS.goManager, "home")) event("go", "started IPvGO manager");
    }

    // ---- stocks: keep the planner's infra share in cash, pause while the casino bets ----
    if (cfg.manageStocks) {
      const casinoBetting = ns.isRunning(SCRIPTS.casinoTable, "home");
      const reserveFrac = Math.max(DEFAULT_STOCKS.reserveFrac, current?.infraSpend ?? 0);
      const ctl: StocksControl = { trade: !casinoBetting, cfg: { reserveFrac, ...cfg.stocks } };
      writeJson(ns, DATA.stocksConfig, ctl);
      if (!ns.isRunning(SCRIPTS.stocksManager, "home") && ns.getServerMaxRam("home") >= cfg.stocksMinHomeGB && ns.exec(SCRIPTS.stocksManager, "home"))
        event("stocks", "started stock manager");
    }

    // ---- hacknet: budget follows the planner's infra share; no buying while the casino bets ----
    // hacknet *servers* (hashes) need SF9 or BitNode 9; plain hacknet nodes make money instead
    const hashServers = !!s && ((s.sourceFiles["9"] ?? 0) > 0 || s.node === 9);
    if (cfg.manageHacknet && hashServers) {
      const ctl: HacknetControl = {
        buy: !ns.isRunning(SCRIPTS.casinoTable, "home"),
        cfg: { budgetFrac: Math.max(0.05, current?.infraSpend ?? 0.25), ...cfg.hacknet },
      };
      writeJson(ns, DATA.hacknetConfig, ctl);
      if (!ns.isRunning(SCRIPTS.hacknetManager, "home") && ns.exec(SCRIPTS.hacknetManager, "home")) event("hacknet", "started hacknet manager");
    }

    // ---- coding contracts (and, once per build, the solver self-test on dummies) ----
    if (cfg.manageContracts) {
      if (!selftestStarted && readJson<{ build?: string }>(ns, DATA.contractsSelftest, {}).build !== build)
        selftestStarted = spawnTask(ns, "tasks/contracts-selftest.js", [build]) > 0;
      if (Date.now() - lastContracts > cfg.contractsEveryMs && spawnTask(ns, "tasks/contracts.js") > 0) lastContracts = Date.now();
    }

    // ---- hacking manager ----
    const wanted: string[] = [];
    if (s?.gang && cfg.manageGang) wanted.push(SCRIPTS.gangManager);
    if (cfg.go.enabled !== false) wanted.push(SCRIPTS.goManager);
    if (bladeburnerWanted) wanted.push(SCRIPTS.bladeburnerManager);
    if (cfg.manageStocks && ns.getServerMaxRam("home") >= cfg.stocksMinHomeGB) wanted.push(SCRIPTS.stocksManager);
    if (cfg.manageHacknet && s && ((s.sourceFiles["9"] ?? 0) > 0 || s.node === 9)) wanted.push(SCRIPTS.hacknetManager);
    // keep room for the casino table while this install's $10b allowance is unclaimed
    if (s && cfg.casino && (s.earned.casino ?? 0) < CASINO_CAP) wanted.push(SCRIPTS.casinoTable);
    // plus room for the Stanek charger while it waits for a big enough block of home RAM
    const reserve = homeReserve(ns, wanted, stanekStatus?.reserveGB ?? 0);
    const hackCfg: Partial<HackConfig> = {
      homeReserve: reserve,
      // lend spare RAM to factions while we are working for one
      share: s?.work?.type === "FACTION" ? 1 : 0,
      skipHosts: stanekStatus?.reserveHosts ?? [],
    };
    writeJson(ns, DATA.hackConfig, hackCfg);
    if (!ns.isRunning(SCRIPTS.hackManager, "home")) {
      const pid = ns.exec(SCRIPTS.hackManager, "home");
      if (pid) event("hack", "started hacking manager");
    }

    // ---- factions & augmentations ----
    if (s && Date.now() - lastFactions > cfg.factionsEveryMs) {
      lastFactions = Date.now();
      current = (await factionsModule(ns, s, m, cfg, { ...DEFAULT_PLAN, ...cfg.plan }, event)) ?? current;
      const notes = current?.notes.join("; ") ?? "";
      if (notes && notes !== lastNotes) event("plan", notes);
      lastNotes = notes;
    }

    // ---- economy (frozen while casino.js bets: spending would make the game reject a bet) ----
    if (s && Date.now() - lastEconomy > cfg.economyEveryMs && !ns.isRunning(SCRIPTS.casinoTable, "home")) {
      lastEconomy = Date.now();
      const spend = cfg.infraSpend ?? current?.infraSpend ?? 0.5;
      const r = await runTask<string[]>(ns, "tasks/economy.js", [s.money * spend]);
      if (r.ok) for (const a of r.value ?? []) event("buy", a);
      else if (r.reason !== "ram") event("error", `economy failed: ${r.error}`);
    }

    // ---- persistence ----
    if (s) {
      const hackStatus = readJson<{ expectedPerSec?: number; poolTotal?: number }>(ns, DATA.hack, {});
      writeJson(ns, DATA.status, { snapshot: s, metrics: m, hack: hackStatus, plan: current, stanek: stanekStatus });
      if (Date.now() - lastMetricsLine > 60_000) {
        lastMetricsLine = Date.now();
        appendJsonl(ns, DATA.metrics, metricsLine(s, m, hackStatus), 10_000);
      }
      draw(ns, s, m, hackStatus, current, recent);
    }

    await ns.sleep(cfg.tickMs);
  }
}

/** Kill everything on home except the daemon (before install/destroy, which wipe scripts anyway). */
function freeHome(ns: NS): void {
  for (const proc of ns.ps("home")) if (proc.pid !== ns.pid) ns.kill(proc.pid);
}

/** Tasks that only run right before a reset; they get RAM by freeing home instead of a permanent reserve. */
const ONE_OFF_TASKS = ["tasks/install.js", "tasks/destroy.js", "tasks/contracts-selftest.js", "tasks/restart.js"];

/** RAM to keep free on home for tasks: the biggest frequently-run task + headroom. */
function homeReserve(ns: NS, wanted: string[] = [], extraGB = 0): number {
  const tasks = ns.ls("home", "tasks/").filter((f) => f.endsWith(".js") && !ONE_OFF_TASKS.includes(f));
  const biggest = Math.max(0, ...tasks.map((t) => ns.getScriptRam(t, "home")));
  // long-running managers that should be up but aren't: hold their RAM back so they can start
  const pendingStart = wanted
    .filter((f) => !ns.isRunning(f, "home"))
    .reduce((sum, f) => sum + ns.getScriptRam(f, "home"), 0);
  const home = ns.getServerMaxRam("home");
  // never reserve more than half of home (+ whatever Stanek asked for, itself ≤ its share of home)
  return Math.min(home / 2, biggest + 8 + pendingStart) + extraGB;
}

const CASINO_CAP = 10e9;

/**
 * Start casino.js when this install's $10b casino allowance is unclaimed and normal income
 * would take more than 30 minutes to make that much — i.e. at the start of a BitNode, not late game.
 * casino.js records its outcome per install, so a failed attempt isn't retried every tick.
 *
 * Every save-scum reload restarts the daemon, so the metric windows are always empty while
 * the casino runs (income reads 0). Rates that need no history (gang, hacking manager) and
 * money on hand are checked too; otherwise a late-game install burns ~15 min of reloads
 * for what the gang makes in seconds.
 */
function casinoModule(ns: NS, s: Snapshot, m: Metrics, event: (k: string, msg: string, d?: unknown) => void) {
  if (ns.isRunning(SCRIPTS.casinoTable, "home")) return;
  if ((s.earned.casino ?? 0) >= CASINO_CAP) return;
  if (s.money >= CASINO_CAP) return; // it could at most double what we already hold
  // don't trust an empty window: give the rate trackers a minute after (re)start
  if (m.short.window < 60_000) return;
  const hackRate = readJson<{ expectedPerSec?: number }>(ns, DATA.hack, {}).expectedPerSec ?? 0;
  const gangRate = (s.gang?.moneyRate ?? 0) * 5; // moneyGainRate is per 200 ms gang cycle
  const income = Math.max(m.short.income, m.long.income, gangRate + hackRate);
  if (income * 1800 >= CASINO_CAP) return;
  const last = readJson<{ lastAugReset?: number }>(ns, DATA.casino, {});
  if (last.lastAugReset === s.lastAugReset) return;
  if (ns.exec(SCRIPTS.casino, "home")) event("casino", "started blackjack save-scummer for the $10b casino allowance");
}

const TRAVEL_COOLDOWN_MS = 120_000;
let lastTravel = 0;
let sleeveSummary = "";
let stanekStatus: StanekStatus | null = null;

/** Factions that can host a gang (combat ones first: territory, better augs for rep play). */
const GANG_FACTIONS = [
  "Speakers for the Dead",
  "The Dark Army",
  "The Syndicate",
  "Tetrads",
  "Slum Snakes",
  "The Black Hand",
  "NiteSec",
];

/** Create the gang when karma allows, keep the manager running, and steer its mode. */
async function gangModule(ns: NS, data: FactionData, p: Plan, dcfg: DaemonConfig, event: (k: string, msg: string, d?: unknown) => void) {
  if (!data.gangFaction) {
    if (data.karma > GANG_KARMA) return;
    const owned = new Set([...data.installed, ...data.queued]);
    const worth = (f: string) =>
      (data.factions[f]?.augs ?? []).filter((a) => a !== NFG && !owned.has(a)).reduce((sum, a) => sum + augValue(data.augs[a]?.stats ?? {}, DEFAULT_PLAN.weights), 0);
    const choice = GANG_FACTIONS.filter((f) => data.factions[f]?.joined).sort((a, b) => worth(b) - worth(a))[0];
    if (!choice) return;
    if (await call<boolean>(ns, "gang.createGang", choice)) event("gang", `created a gang with ${choice}`);
    return;
  }
  // respect → gang-faction rep while it still gates augs we want; otherwise money
  const needRep = (p.repGated[data.gangFaction] ?? 0) > 0;
  const gcfg: Partial<GangConfig> = { mode: needRep ? "respect" : "money", ...dcfg.gang };
  // no equipment shopping while casino.js is betting (it needs the money to stay put)
  if (ns.isRunning(SCRIPTS.casinoTable, "home")) Object.assign(gcfg, { equipBudget: 0, augBudget: 0 });
  writeJson(ns, DATA.gangConfig, gcfg);
  if (!ns.isRunning(SCRIPTS.gangManager, "home") && ns.exec(SCRIPTS.gangManager, "home"))
    event("gang", `started gang manager (${gcfg.mode} mode)`);
}

const SIMULACRUM = "The Blade's Simulacrum";
const CHURCH = "Church of the Machine God";
const GENESIS = "Stanek's Gift - Genesis";
/** set while the Bladeburner manager should run, so the hacking manager leaves home RAM for it */
let bladeburnerWanted = false;

/**
 * Start the Bladeburner manager and steer it. Joining is only allowed once Stanek's Gift is
 * settled (accepted, or impossible/disabled): with SF7.3, joining grants The Blade's
 * Simulacrum, and owning it blocks accepting the gift for the rest of the BitNode.
 */
let lastSleeveLog = 0;
/** true once we've joined the Bladeburner division (this BitNode) */
let bbInDivision = false;

/** Joining is safe once Stanek's Gift is accepted, or can't/won't be (see bladeburnerModule). */
function bladeburnerCanJoin(data: FactionData, dcfg: DaemonConfig): boolean {
  if (!dcfg.manageBladeburner || (!(data.sourceFiles["7"] > 0) && data.node !== 7)) return false;
  return data.installed.includes(GENESIS) || (stanekStatus !== null && stanekStatus.state !== "accepted");
}

async function bladeburnerModule(
  ns: NS,
  data: FactionData,
  p: Plan,
  dcfg: DaemonConfig,
  casinoRunning: boolean,
  event: (k: string, msg: string, d?: unknown) => void,
) {
  bladeburnerWanted = false;
  if (!dcfg.manageBladeburner) return;
  if (!(data.sourceFiles["7"] > 0) && data.node !== 7) return; // no API access
  const stanekSettled = bladeburnerCanJoin(data, dcfg);
  const ctl: BladeburnerControl = { canJoin: stanekSettled, usePlayer: p.bladeburner && !casinoRunning, cfg: dcfg.bladeburner };
  // join as soon as the stats allow, even before home can hold the manager: the Simulacrum
  // (SF7.3) and rank both start then. One-off proxy call, 4 GB for a moment.
  const combat = ["strength", "defense", "dexterity", "agility"].every((k) => (data.skills[k] ?? 0) >= 100);
  if (stanekSettled && combat && !bbInDivision) {
    bbInDivision = (await call<boolean>(ns, "bladeburner.joinBladeburnerDivision")) === true;
    if (bbInDivision) event("bladeburner", "joined the Bladeburner division");
  }
  writeJson(ns, DATA.bladeburnerConfig, ctl);
  if (ns.isRunning(SCRIPTS.bladeburnerManager, "home")) {
    bladeburnerWanted = true;
    return;
  }
  if (!stanekSettled || ns.getServerMaxRam("home") < dcfg.bladeburnerMinHomeGB) return;
  bladeburnerWanted = true;
  if (ns.exec(SCRIPTS.bladeburnerManager, "home")) event("bladeburner", "started Bladeburner manager");
}

function summarizeSleeves(list: { kind: string; faction?: string; crime?: string }[]): string {
  const counts = new Map<string, number>();
  for (const a of list) {
    const k = a.kind === "faction" ? a.faction! : a.kind === "crime" ? a.crime! : a.kind === "bladeburner" ? "Bladeburner" : "recovery";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(", ");
}

/** Scan factions/augs, plan, and act on the plan. Returns the plan (or null if the scan failed). */
async function factionsModule(
  ns: NS,
  s: Snapshot,
  m: Metrics,
  dcfg: DaemonConfig,
  cfg: PlanConfig,
  event: (k: string, msg: string, d?: unknown) => void,
): Promise<Plan | null> {
  let data: FactionData;
  try {
    data = await collectFactionData(ns);
  } catch (e) {
    event("error", `faction scan failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  // money in stocks is money: tasks/install.js liquidates before buying
  const stocks = readJson<Partial<StocksStatus>>(ns, DATA.stocks, {});
  if (stocks.t && Date.now() - stocks.t < 120_000 && (stocks.value ?? 0) > 0) data.money += stocks.value!;
  const r = m.long.window >= 120_000 ? m.long : m.short;
  const work = s.work as { factionName?: string } | null;
  const p = makePlan(
    {
      data,
      observedRep: r.rep,
      income: r.income,
      sinceInstall: m.sinceInstall,
      currentWork: work?.factionName ?? null,
      ratesReady: m.long.window >= 120_000,
      bladeburner: {
        inDivision: bbInDivision || readJson<Partial<BladeburnerStatus>>(ns, DATA.bladeburner, {}).inDivision === true,
        simulacrum: data.installed.includes(SIMULACRUM),
        canJoin: bladeburnerCanJoin(data, dcfg),
      },
    },
    cfg,
  );

  // Operation Daedalus done also unlocks the destroy, with no hack level needed
  const bbWon = cfg.autoDestroy && readJson<Partial<BladeburnerStatus>>(ns, DATA.bladeburner, {}).blackOpsDone === true;
  if (p.destroy || bbWon) {
    event("destroy", `${bbWon ? "Bladeburner black ops complete" : "w0r1d_d43m0n is ready"} — destroying the BitNode`);
    freeHome(ns);
    spawnTask(ns, "tasks/destroy.js", [cfg.nextNode]);
    return p;
  }

  const act: ActArgs = { join: p.join, travelTo: p.travelTo, work: p.work, crime: p.crime, buyNow: p.buyNow, train: p.train };
  // casino.js drives the UI (blackjack table); work/travel would navigate away from it
  const casinoRunning = ns.isRunning(SCRIPTS.casinoTable, "home");
  if (casinoRunning) {
    act.work = null;
    act.crime = null;
    act.travelTo = null;
    act.train = null;
  }
  // the planner is stateless; a cooldown stops it from bouncing between cities
  if (act.travelTo) {
    if (Date.now() - lastTravel < TRAVEL_COOLDOWN_MS) act.travelTo = null;
    else lastTravel = Date.now();
  }
  // don't fight the player over work while a gang/crime module isn't steering it
  if (!cfg.manageWork) {
    act.work = null;
    act.crime = null;
  }
  if (dcfg.manageGang) await gangModule(ns, data, p, dcfg, event);

  // Stanek before anything can buy an aug: the gift can only be accepted with no augs
  try {
    stanekStatus = await manageStanek(ns, data, s.homeCores, { ...DEFAULT_STANEK, ...dcfg.stanek }, event, homeReserve(ns),
      (p.repGated[CHURCH] ?? 0) > 0, // Church augs still need rep → extra chargers
    );
  } catch (e) {
    event("error", `stanek failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  await bladeburnerModule(ns, data, p, dcfg, casinoRunning, event);

  // sleeves first, so none of them is sitting on the faction the player is about to work for
  if (dcfg.manageSleeves && s.sleeves > 0) {
    try {
      const targets = p.grindFactions;
      const needKarma = !data.gangFaction && data.karma > GANG_KARMA;
      const rep = await manageSleeves(
        ns,
        data,
        targets,
        p.favorFactions,
        act.work?.faction ?? null,
        needKarma,
        casinoRunning ? 0 : undefined, // no sleeve aug purchases while casino.js is betting
        {
          recovery: { ...DEFAULT_RECOVERY, ...dcfg.sleeveRecovery },
          bladeburner: bbInDivision && readJson<Partial<BladeburnerStatus>>(ns, DATA.bladeburner, {}).blackOpsDone !== true,
        },
      );
      // shock-recovery experiment: one line per minute (tools/sleeve-shock.mjs to analyse later)
      if (Date.now() - lastSleeveLog > 60_000) {
        lastSleeveLog = Date.now();
        appendJsonl(ns, DATA.sleeves, { t: Date.now(), sleeves: rep.rows, observedRep: m.short.rep, sleeveIncome: m.short.bySource.sleeves ?? 0 }, 20_000);
      }
      for (const c of rep.changed) event("sleeve", c);
      if (rep.augsBought) event("sleeve", `bought ${rep.augsBought} sleeve augmentation(s)`);
      sleeveSummary = summarizeSleeves(rep.assignments);
    } catch (e) {
      event("error", `sleeves failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const done = await runTask<string[]>(ns, "tasks/factions-act.js", [JSON.stringify(act)]);
  if (done.ok) for (const d of done.value ?? []) event("faction", d);
  else if (done.reason !== "ram") event("error", `faction actions failed: ${done.error}`);

  if (p.backdoor.length && spawnTask(ns, "tasks/backdoor.js", [p.backdoor[0]]))
    event("backdoor", `installing backdoor on ${p.backdoor[0]}`);

  if (p.install && !casinoRunning) {
    event("install", `install planned: ${p.install.reason}`, {
      buy: p.install.buy.map(([, a]) => a),
      cost: p.readyCost,
      sinceInstall: m.sinceInstall,
      money: s.money,
    });
    freeHome(ns);
    spawnTask(ns, "tasks/install.js", [JSON.stringify(p.install)]);
  }
  return p;
}

function metricsLine(s: Snapshot, m: Metrics, hack: { expectedPerSec?: number; poolTotal?: number }) {
  const r = m.long.window >= 120_000 ? m.long : m.short;
  return {
    t: s.t,
    node: s.node,
    sinceInstall: m.sinceInstall,
    money: s.money,
    incomePerSec: r.income,
    incomeBySource: Object.fromEntries(Object.entries(r.bySource).filter(([, v]) => v !== 0)),
    repPerSec: r.rep,
    repPerSecTotal: r.repTotal,
    karma: s.karma,
    karmaPerSec: r.karma,
    timeToGang: Number.isFinite(m.timeToGang) ? m.timeToGang : null,
    hackLevel: s.hackLevel,
    hackExpPerSec: r.hackExp,
    hackExpected: hack.expectedPerSec ?? 0,
    ramPool: hack.poolTotal ?? 0,
    homeRam: s.homeRam,
    work: s.work?.type ?? null,
  };
}

/** Detect augment installs / node resets and write one summary line per finished run. */
function trackRuns(ns: NS, s: Snapshot, tracker: MetricsTracker, event: (k: string, m: string, d?: unknown) => void) {
  const st = readJson<(DaemonState & { run?: DaemonState["cur"] }) | null>(ns, STATE_FILE, null);
  const m = tracker.metrics();
  const r = m.long.window >= 120_000 ? m.long : m.short;
  // migrate older state files (the field used to be called `run`) and repair partial ones
  if (st && !st.cur) {
    // bracket access: a bare `.run` would cost 1 GB (it matches ns.run in the RAM calculator)
    st.cur = st["run"] ?? {
      start: st.lastAugReset ?? s.lastAugReset,
      peakIncome: 0,
      peakRepRate: 0,
      hackLevel: s.hackLevel,
      augsInstalled: s.augsInstalled,
    };
    delete st["run"];
  }
  if (!st || typeof st.lastAugReset !== "number") {
    writeJson(ns, STATE_FILE, {
      lastAugReset: s.lastAugReset,
      lastNodeReset: s.lastNodeReset,
      installs: 0,
      cur: { start: s.lastAugReset, peakIncome: 0, peakRepRate: 0, hackLevel: s.hackLevel, augsInstalled: s.augsInstalled },
    } satisfies DaemonState);
    return;
  }
  if (st.lastAugReset !== s.lastAugReset) {
    const nodeReset = st.lastNodeReset !== s.lastNodeReset;
    appendJsonl(ns, DATA.runs, {
      t: s.t,
      kind: nodeReset ? "node" : "install",
      node: s.node,
      durationMs: s.lastAugReset - st.cur.start,
      peakIncomePerSec: st.cur.peakIncome,
      peakRepPerSec: st.cur.peakRepRate,
      endHackLevel: st.cur.hackLevel,
      augsBefore: st.cur.augsInstalled,
      augsAfter: s.augsInstalled,
    });
    event("reset", nodeReset ? "BitNode reset detected" : `augments installed (+${s.augsInstalled - st.cur.augsInstalled})`);
    st.installs++;
    st.lastAugReset = s.lastAugReset;
    st.lastNodeReset = s.lastNodeReset;
    st.cur = { start: s.lastAugReset, peakIncome: 0, peakRepRate: 0, hackLevel: s.hackLevel, augsInstalled: s.augsInstalled };
  }
  st.cur.peakIncome = Math.max(st.cur.peakIncome, r.income);
  st.cur.peakRepRate = Math.max(st.cur.peakRepRate, r.repTotal);
  st.cur.hackLevel = s.hackLevel;
  writeJson(ns, STATE_FILE, st);
}

function draw(
  ns: NS,
  s: Snapshot,
  m: Metrics,
  hack: { expectedPerSec?: number; poolTotal?: number },
  plan: Plan | null,
  recent: string[],
) {
  const r = m.long.window >= 120_000 ? m.long : m.short;
  const L: string[] = [];
  L.push(`BN${s.node}  ·  ${dur(m.sinceInstall)} since install  ·  hack ${s.hackLevel}  ·  ports ${portOpenerCount(ns)}/5`);
  L.push(`money ${money(s.money)}   income ${money(m.short.income)}/s (1m)  ${money(m.long.income)}/s (10m)`);
  const top = Object.entries(r.bySource)
    .filter(([, v]) => Math.abs(v) > 0.5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k} ${money(v)}/s`);
  if (top.length) L.push(`  ${top.join("  ·  ")}`);
  L.push(`hacking: pool ${ram(hack.poolTotal ?? 0)}  expected ${money(hack.expectedPerSec ?? 0)}/s   home ${ram(s.homeRam)} / ${s.homeCores}c`);

  L.push("");
  L.push(`rep/s total ${num(r.repTotal)}   work: ${describeWork(s)}`);
  const facs = Object.entries(s.rep).sort((a, b) => (r.rep[b[0]] ?? 0) - (r.rep[a[0]] ?? 0) || b[1] - a[1]);
  for (const [f, rep] of facs.slice(0, 6))
    L.push(`  ${pad(f, 24)} ${pad(num(rep), 9, true)} rep  ${pad(num(r.rep[f] ?? 0), 8, true)}/s  favor ${num(s.favor[f] ?? 0, 0)}`);
  if (s.invites.length) L.push(`  invites: ${s.invites.join(", ")}`);

  const hn = readJson<Partial<HacknetStatus>>(ns, DATA.hacknet, {});
  if (hn.t && Date.now() - hn.t < 120_000)
    L.push(
      `hacknet: ${hn.servers ?? 0} servers  ${num(hn.production ?? 0)} h/s  ${num(hn.hashes ?? 0)}/${num(hn.capacity ?? 0)} hashes  ${hn.decision || hn.note || ""}`,
    );
  const st = readJson<Partial<StocksStatus>>(ns, DATA.stocks, {});
  if (st.t && Date.now() - st.t < 120_000)
    L.push(
      st.access?.api4s
        ? `stocks: ${money(st.value ?? 0)} in ${st.positions ?? 0} positions  realized ${money(st.realized ?? 0)}  ${st.trades ?? 0} trades${st.note ? `  (${st.note})` : ""}`
        : `stocks: ${st.note}`,
    );
  const bb = readJson<Partial<BladeburnerStatus>>(ns, DATA.bladeburner, {});
  if (bb.t && Date.now() - bb.t < 120_000) {
    L.push("");
    L.push(
      bb.inDivision
        ? `bladeburner: rank ${num(bb.rank ?? 0)}${bb.rankPerSec ? ` (+${num(bb.rankPerSec)}/s, Daedalus ${num(bb.finalRank ?? 0)} in ${bb.finalEtaSec != null ? dur(bb.finalEtaSec * 1000) : "?"})` : ""}  ${bb.city} chaos ${(bb.chaos ?? 0).toFixed(0)}  stamina ${bb.stamina ? ((bb.stamina[0] / Math.max(1, bb.stamina[1])) * 100).toFixed(0) : "?"}%  ${bb.action ? `${bb.action.name} (${bb.why})` : bb.note}`
        : `bladeburner: ${bb.note}`,
    );
  }
  L.push("");
  if (s.gang) {
    const g = readJson<{ mode?: string; tasks?: Record<string, number>; warfare?: boolean; wantedPenalty?: number }>(ns, DATA.gang, {});
    L.push(`gang ${s.gang.faction}: ${s.gang.members} members  respect ${num(s.gang.respect)}  territory ${(s.gang.territory * 100).toFixed(1)}%${g.warfare ? " (warfare)" : ""}  ${money(s.gang.moneyRate * 5)}/s`);
    if (g.tasks)
      L.push(`  ${g.mode ?? "?"} mode · ${Object.entries(g.tasks).map(([t, n]) => `${t} ${n}`).join(" · ")} · wanted penalty ${(100 - (g.wantedPenalty ?? 1) * 100).toFixed(1)}%`);
  } else {
    L.push(`karma ${num(s.karma)} / ${num(GANG_KARMA)}  (${num(r.karma)}/s)  →  time to gang ${dur(m.timeToGang)}`);
  }
  L.push(`sleeves ${s.sleeves}${sleeveSummary ? `: ${sleeveSummary}` : ""}   kills ${s.kills}`);
  if (stanekStatus && stanekStatus.state !== "no SF13") {
    const st = stanekStatus;
    const bonus = Object.entries(st.bonus)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} +${(v * 100).toFixed(1)}%`)
      .join(" · ");
    const what = st.charging ? "charging" : st.waitingForRam ? "waiting for RAM to charge" : st.state;
    L.push(`stanek ${st.width}×${st.height}: ${st.fragments} pieces (layout ${st.layoutScore.toFixed(1)}/${st.bestScore.toFixed(1)}) · ${what}${bonus ? ` · ${bonus}` : ""}`);
  }

  if (plan) {
    L.push("");
    L.push(
      `augs: ${plan.ready.length} ready (${money(plan.readyCost)})  ·  next in ${dur(plan.nextEta)}  ·  infra spend ${(plan.infraSpend * 100).toFixed(0)}%`,
    );
    for (const c of plan.pending.slice(0, 4))
      L.push(`  ${pad(c.aug, 34)} ${pad(c.faction, 18)} ${pad(money(c.price), 9, true)}  ${dur(c.eta)}`);
    if (plan.install) L.push(`  → installing: ${plan.install.reason}`);
  }

  if (recent.length) {
    L.push("");
    L.push(...recent);
  }
  ns.clearLog();
  ns.print(L.join("\n"));
}

function describeWork(s: Snapshot): string {
  const w = s.work;
  if (!w) return "idle";
  switch (w.type) {
    case "FACTION":
      return `${w.factionName} (${w.factionWorkType})`;
    case "COMPANY":
      return `company ${w.companyName}`;
    case "CRIME":
      return `crime ${w.crimeType}`;
    case "CLASS":
      return `class ${w.classType}`;
    default:
      return w.type.toLowerCase();
  }
}
