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
import { call, callEach, CallError } from "./lib/call.js";
import { collectFactionData } from "./lib/plan/collect.js";
import { NFG, type FactionData } from "./lib/plan/data.js";
import { augValue, DAEDALUS_MONEY, DEFAULT_PLAN, plan as makePlan, routeWeights, type Plan, type PlanConfig } from "./lib/plan/factions.js";
import type { GangConfig } from "./lib/plan/gang.js";
import type { GoConfig } from "./lib/plan/go.js";
import { manageSleeves } from "./lib/sleeves.js";
import { DEFAULT_STANEK, manageStanek, type StanekConfig, type StanekStatus } from "./lib/stanek.js";
import { runTask, spawnTask } from "./lib/task.js";
import type { GraftState, Snapshot } from "./lib/types.js";
import type { HackConfig } from "./hack/manager.js";
import { act as doActions, type ActArgs } from "./lib/act.js";
import type { BladeburnerControl, BladeburnerStatus } from "./bladeburner/manager.js";
import type { BbConfig } from "./lib/plan/bladeburner.js";
import { DEFAULT_RECOVERY, shouldFarmKarma, type RecoveryConfig } from "./lib/plan/sleeves.js";
import { DEFAULT_STOCKS, type StockConfig } from "./lib/plan/stocks.js";
import type { StocksControl, StocksStatus } from "./stocks/manager.js";
import type { HacknetControl, HacknetStatus } from "./hacknet/manager.js";
import { expectedRunMs, type HacknetConfig } from "./lib/plan/hacknet.js";
import { averageRate, compareRun, tally, valueRuns, type RunRecord, type Tally } from "./lib/plan/runs.js";
import type { CorpConfig } from "./lib/plan/corp.js";
import { chooseTarget, cooldownAfter, DEFAULT_INFILTRATION, type InfiltrationConfig } from "./lib/plan/infiltration.js";
import {
  chooseGraft,
  CONGRUITY,
  DEFAULT_GRAFTING,
  entropyCost,
  evaluateGrafts,
  type GraftRow,
  type GraftingConfig,
} from "./lib/plan/grafting.js";
import type { InfiltrationControl, InfiltrationState } from "./infiltrate.js";
import type { CorpControl, CorpStatus } from "./corp/manager.js";

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
  /** Corporation (corp/manager.js, needs SF3 or BN3): Agriculture, investors, dividends. */
  /**
   * Your own long-running scripts (e.g. under src/user/): the daemon starts each one when it's
   * missing, holds home RAM for it, and restarts it on new builds. See README "User modules".
   */
  userModules: UserModule[];
  /** Share of the hacking pool farming XP while a hacking level gates something (plan.hackXp). */
  hackXpShare: number;
  /** Once money no longer gates Daedalus, use this share instead (money is not the bottleneck). */
  hackXpShareMax: number;
  /** Log graftable augs (value vs. entropy and time) even when auto-grafting is off. */
  logGrafting: boolean;
  /** Auto-graft when a graft is worth its time and cumulative Entropy hit (see lib/plan/grafting.ts). */
  grafting: Partial<GraftingConfig>;
  /** Infiltration autoplayer (infiltrate.js) when it beats faction work for the grind faction. */
  manageInfiltration: boolean;
  infiltration: Partial<InfiltrationConfig>;
  manageCorp: boolean;
  corp: Partial<CorpConfig>;
  /** Hacknet servers: spend hashes by value, buy production by payback (hacknet/manager.js). */
  manageHacknet: boolean;
  hacknet: Partial<HacknetConfig>;
  manageStocks: boolean;
  stocks: Partial<StockConfig>;
  /** Buy stock-market access once its cost is at most this share of cash (1 = as soon as affordable). */
  stocksAccessBudgetFrac: number;
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
  userModules: [],
  hackXpShare: 0.5,
  hackXpShareMax: 0.9,
  logGrafting: true,
  grafting: {},
  manageInfiltration: true,
  infiltration: {},
  manageCorp: true,
  corp: {},
  manageHacknet: true,
  hacknet: {},
  manageStocks: true,
  stocks: {},
  stocksAccessBudgetFrac: 0.5,
  stocksMinHomeGB: 512,
  sleeveRecovery: { mode: "off" },
  manageBladeburner: true,
  bladeburner: {},
  bladeburnerMinHomeGB: 2048,
};

export interface UserModule {
  /** script path on home, e.g. "user/mine.js" */
  script: string;
  args?: (string | number | boolean)[];
  /** don't start it below this much home RAM */
  minHomeGB?: number;
}

/** What user modules can read each tick (data/context.txt). */
export interface DaemonContext {
  t: number;
  node: number;
  money: number;
  hackLevel: number;
  homeRam: number;
  homeFree: number;
  /** a UI-driving script (casino.js / infiltrate.js) or a graft owns the player: don't navigate or change work */
  uiBusy: boolean;
  /** the faction the player works for, if any; an install about to happen */
  workFaction: string | null;
  installPlanned: boolean;
  sinceInstallMs: number;
}

interface DaemonState {
  lastAugReset: number;
  lastNodeReset: number;
  installs: number;
  /** installs so far this BitNode (for data/nodes.txt) */
  nodeInstalls?: number;
  /** milestone → ms since this BitNode started (first time each happened) */
  milestones?: Record<string, number>;
  /** totals across every run in this BitNode, for the node comparison line */
  nodeEarned?: Record<string, number>;
  nodeSpent?: number;
  nodeHackExp?: number;
  nodePeakIncome?: number;
  nodePeakRep?: number;
  nodePeakMoney?: number;
  /** Peak values of the run in progress, summarized into data/runs.txt on reset. */
  cur: {
    start: number;
    peakIncome: number;
    peakRepRate: number;
    hackLevel: number;
    augsInstalled: number;
    startMoney?: number;
    lastMoney?: number;
    peakMoney?: number;
    startHackLevel?: number;
    startHackExp?: number;
    lastHackExp?: number;
    startRepTotal?: number;
    lastRepTotal?: number;
    lastEarned?: Snapshot["earned"];
    /** time of the last snapshot, to spot stretches nothing was tracked (game closed, daemon down) */
    lastT?: number;
    /** untracked ms inside this run (sum of snapshot gaps over GAP_MS) */
    gapMs?: number;
    /** BitNode level being played (source-file level + 1), fixed at run start */
    nodeLevel?: number;
    /** every build that ran during this run, in order */
    builds?: string[];
    /** rooted RAM by kind at run start and at the last tick (hack/manager.ts `ramBy`) */
    startRam?: RamBy;
    lastRam?: RamBy;
    /** hash purchases this run, summed across hacknet manager restarts */
    hashes?: Tally;
    /** hacknet production purchases this run (level/ram/cores/server/cache) */
    hashProduction?: Tally;
    lastHashRate?: number;
  };
  /** untracked ms this BitNode, and every build that ran in it */
  nodeGapMs?: number;
  nodeBuilds?: string[];
}

/** Rooted RAM by kind, GB (written by hack/manager.ts). */
type RamBy = { homeGB: number; cloudGB: number; hnetGB: number; otherGB: number; skippedGB: number; usedGB: number };

/** What the daemon reads from data/hack.txt. */
interface HackInfo {
  expectedPerSec?: number;
  poolTotal?: number;
  managedRam?: number;
  ramBy?: RamBy;
  shareThreads?: number;
  shareOnly?: boolean;
}

/** A snapshot gap longer than this counts as untracked time (ticks are seconds apart). */
const GAP_MS = 5 * 60_000;

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
  let lastCleanup = 0;
  let selftestStarted = false;
  let current: Plan | null = null;
  let lastNotes = "";
  let lastError = "";
  let lastShareOnly = false;

  const event = (kind: string, msg: string, data?: unknown) => {
    appendJsonl(ns, DATA.events, { t: Date.now(), kind, msg, data }, 3000);
    recent.unshift(`${new Date().toLocaleTimeString()} ${msg}`);
    recent.length = Math.min(recent.length, 8);
  };

  const build = ns.read(BUILD_MARKER);
  event("start", "daemon started", { build });
  // why each gated action isn't happening; kept in a file so the casino's reloads
  // (each restarts the daemon) don't log the same reason a hundred times
  const gates = readJson<Record<string, string>>(ns, DATA.gates, {});
  const gate = (name: string, g: { key: string; msg: string } | null) => {
    const key = g?.key ?? "";
    if ((gates[name] ?? "") === key) return;
    gates[name] = key;
    writeJson(ns, DATA.gates, gates);
    if (g) event("gate", `${name}: ${g.msg}`, { gate: name, key });
  };

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
      trackRuns(ns, snap.value, tracker, event, build);
    } else if (snap.error !== lastError) {
      lastError = snap.error ?? "";
      event("error", `snapshot failed: ${snap.error}`);
    }
    const s = tracker.latest();
    const m = tracker.metrics();

    // ---- casino ($10b per install, early in a run) ----
    if (s && cfg.casino) gate("casino", casinoModule(ns, s, m, event));

    // ---- IPvGO manager ----
    if (cfg.go.enabled !== false) {
      writeJson(ns, DATA.goConfig, cfg.go);
      if (!ns.isRunning(SCRIPTS.goManager, "home") && ns.exec(SCRIPTS.goManager, "home")) event("go", "started IPvGO manager");
    }

    // ---- stocks: keep the planner's infra share in cash, pause while the casino bets ----
    if (cfg.manageStocks) {
      const casinoBetting = ns.isRunning(SCRIPTS.casinoTable, "home");
      const reserveCash = !!current?.shareAll || !!current?.redPillPush;
      const reserveFrac = Math.max(DEFAULT_STOCKS.reserveFrac, current?.infraSpend ?? 0);
      const ctl: StocksControl = {
        trade: !casinoBetting,
        accessBudgetFrac: reserveCash ? 0 : cfg.stocksAccessBudgetFrac,
        cfg: { reserveFrac, ...cfg.stocks },
      };
      writeJson(ns, DATA.stocksConfig, ctl);
      if (!ns.isRunning(SCRIPTS.stocksManager, "home") && ns.getServerMaxRam("home") >= cfg.stocksMinHomeGB && ns.exec(SCRIPTS.stocksManager, "home"))
        event("stocks", "started stock manager");
    }

    // ---- hacknet: budget follows the planner's infra share; no buying while the casino bets ----
    // hacknet *servers* (hashes) need SF9 or BitNode 9; plain hacknet nodes make money instead
    const hashServers = !!s && ((s.sourceFiles["9"] ?? 0) > 0 || s.node === 9);
    if (cfg.manageHacknet && hashServers) {
      const ctl: HacknetControl = {
        buy: !ns.isRunning(SCRIPTS.casinoTable, "home") && !current?.redPillPush,
        cfg: { budgetFrac: Math.max(0.05, current?.infraSpend ?? 0.25), ...cfg.hacknet },
      };
      if (current?.shareAll) {
        ctl.reserve = current.augReserve;
        ctl.shareRam = true;
        // share-only spending is centralised in economy.js so left-over cloud budget
        // can spill into hacknet RAM without two scripts racing for the same cash
        if (cfg.infraSpend == null) {
          ctl.buy = false;
          ctl.budget = 0;
        }
      }
      writeJson(ns, DATA.hacknetConfig, ctl);
      if (!ns.isRunning(SCRIPTS.hacknetManager, "home") && ns.exec(SCRIPTS.hacknetManager, "home")) event("hacknet", "started hacknet manager");
    }

    // ---- corporation (SF3 / BN3): creation waits for spare cash and no casino bets ----
    const corpOk = cfg.manageCorp && !!s && ((s.sourceFiles["3"] ?? 0) > 0 || s.node === 3);
    if (corpOk) {
      // bribe target: the rep gap of the faction being ground, else the biggest pending gap
      // (bribes, like donations, need a faction that offers work)
      const gaps = (current?.pending ?? []).filter((c) => c.repGap > 0 && c.donation === 0 && workableFactions.has(c.faction));
      const gap = gaps.find((c) => c.faction === current?.work?.faction) ?? [...gaps].sort((a, b) => b.repGap - a.repGap)[0];
      const ctl: CorpControl = {
        // creating a corporation costs $150b: never while the Red Pill is the goal
        allowCreate: !ns.isRunning(SCRIPTS.casinoTable, "home") && !current?.shareAll && !current?.redPillPush,
        bribeTarget: gap ? { faction: gap.faction, repGap: gap.repGap } : null,
        cfg: cfg.corp,
      };
      writeJson(ns, DATA.corpConfig, ctl);
      if (!ns.isRunning(SCRIPTS.corpManager, "home") && ns.exec(SCRIPTS.corpManager, "home")) event("corp", "started corporation manager");
    }

    // ---- coding contracts (and, once per build, the solver self-test on dummies) ----
    if (cfg.manageContracts) {
      if (!selftestStarted && readJson<{ build?: string }>(ns, DATA.contractsSelftest, {}).build !== build)
        selftestStarted = spawnTask(ns, "tasks/contracts-selftest.js", [build]) > 0;
      if (Date.now() - lastContracts > cfg.contractsEveryMs && spawnTask(ns, "tasks/contracts.js") > 0) lastContracts = Date.now();
    }

    // ---- scratch cleanup: stale tmp/call in/out files otherwise stay in the save forever ----
    if (Date.now() - lastCleanup > 30 * 60_000 && spawnTask(ns, "tasks/cleanup.js") > 0) lastCleanup = Date.now();

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
    if (corpOk) wanted.push(SCRIPTS.corpManager);
    // ---- user modules ----
    for (const um of cfg.userModules ?? []) {
      if (!ns.fileExists(um.script, "home") || ns.getServerMaxRam("home") < (um.minHomeGB ?? 0)) continue;
      wanted.push(um.script);
      if (!ns.isRunning(um.script, "home", ...(um.args ?? [])) && ns.exec(um.script, "home", 1, ...(um.args ?? [])))
        event("user", `started user module ${um.script}`);
    }
    // room for infiltrate.js (+ its proxies) while the daemon wants it running
    if (readJson<{ active?: boolean }>(ns, DATA.infiltrationConfig, {}).active) wanted.push(SCRIPTS.infiltrate);
    // corp calls run through ~22 GB proxies (corporation functions cost 10–20 GB each)
    // (only once a corporation exists: before that the manager just waits)
    const corpProxyGB = corpOk && ns.isRunning(SCRIPTS.corpManager, "home") && readJson<{ exists?: boolean }>(ns, DATA.corp, {}).exists ? 22 : 0;
    // other managers' proxies run alongside the daemon's: Go cheats (~9.6 GB), infiltration's
    // location lookups (~16.6 GB)
    const procs = new Set(ns.ps("home").map((x) => x.filename));
    const managerProxyGB = (procs.has(SCRIPTS.goManager) ? 10 : 0) + (procs.has(SCRIPTS.infiltrate) ? 17 : 0);
    const reserve = homeReserve(ns, wanted, (stanekStatus?.reserveGB ?? 0) + corpProxyGB + managerProxyGB);
    lastReserve = reserve;
    const shareOnly = current?.shareAll === true && s?.work?.type === "FACTION";
    if (shareOnly !== lastShareOnly) {
      event(
        "hack",
        shareOnly
          ? "money target met and faction rep is the bottleneck: sharing the whole pool"
          : "money needed again: resuming hacking batches",
      );
      lastShareOnly = shareOnly;
    }
    const hackCfg: Partial<HackConfig> = {
      homeReserve: reserve,
      // lend spare RAM to factions while we are working for one
      shareFrac: s?.work?.type === "FACTION" ? 1 : 0,
      shareOnly,
      // hacking level gating something valuable: farm hacking XP with part of the pool.
      // For Daedalus, money stops being the bottleneck at $100b, so give XP the larger share.
      xpShare:
        !shareOnly && current?.hackXp
          ? Math.min(
              1,
              Math.max(
                0,
                current.hackXp.why === "Daedalus" && (s?.money ?? 0) < DAEDALUS_MONEY
                  ? cfg.hackXpShare
                  : cfg.hackXpShareMax,
              ),
            )
          : 0,
      skipHosts: [...(stanekStatus?.reserveHosts ?? []), ...(readJson<{ hosts?: string[] }>(ns, DATA.userReserve, {}).hosts ?? [])],
    };
    writeJson(ns, DATA.hackConfig, hackCfg);
    if (!ns.isRunning(SCRIPTS.hackManager, "home")) {
      const pid = ns.exec(SCRIPTS.hackManager, "home");
      if (pid) event("hack", "started hacking manager");
    }

    // ---- factions & augmentations ----
    if (s && Date.now() - lastFactions > cfg.factionsEveryMs) {
      try {
        current = (await factionsModule(ns, s, m, cfg, { ...DEFAULT_PLAN, ...cfg.plan }, event)) ?? current;
        lastFactions = Date.now();
      } catch (e) {
        // CallError = no RAM for a proxy right now: try again next tick
        if (!(e instanceof CallError)) {
          lastFactions = Date.now();
          event("error", `faction module failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (current) gate("install", current.install ? null : current.installHold);
      const notes = current?.notes.join("; ") ?? "";
      if (notes && notes !== lastNotes) event("plan", notes);
      lastNotes = notes;
    }

    // ---- economy (frozen while casino.js bets: spending would make the game reject a bet) ----
    if (s && Date.now() - lastEconomy > cfg.economyEveryMs && !ns.isRunning(SCRIPTS.casinoTable, "home")) {
      lastEconomy = Date.now();
      // Share-only: economy.js gets the whole surplus above the aug reserve. It keeps
      // 25% for hacknet RAM and lets any cloud/home budget it cannot use spill there too,
      // so shrinking cloud caps no longer leave cash idle.
      const shareAll = cfg.infraSpend == null && current?.shareAll === true;
      const spend = cfg.infraSpend ?? current?.infraSpend ?? 0.5;
      const budget = shareAll ? Math.max(0, current?.infraBudget ?? 0) : s.money * spend;
      const reserve = current?.infraReserve ?? 0;
      const args: (string | number)[] = [budget, reserve];
      if (shareAll) args.push(0.25);
      const r = await runTask<string[]>(ns, "tasks/economy.js", args);
      if (r.ok) for (const a of r.value ?? []) event("buy", a);
      else if (r.reason !== "ram") event("error", `economy failed: ${r.error}`);
    }

    // ---- persistence ----
    if (s) {
      const hackStatus = readJson<HackInfo>(ns, DATA.hackStatus, {});
      writeJson(ns, DATA.status, { snapshot: s, metrics: m, hack: hackStatus, plan: current, stanek: stanekStatus, ram: ramReport(ns) });
      const ctx: DaemonContext = {
        t: Date.now(),
        node: s.node,
        money: s.money,
        hackLevel: s.hackLevel,
        homeRam: s.homeRam,
        homeFree: ns.getServerMaxRam("home") - ns.getServerUsedRam("home"),
        uiBusy: ns.isRunning(SCRIPTS.casinoTable, "home") || ns.ps("home").some((x) => x.filename === SCRIPTS.infiltrate) || graftingRunning(ns, s),
        workFaction: current?.work?.faction ?? null,
        installPlanned: !!current?.install,
        sinceInstallMs: m.sinceInstall,
      };
      writeJson(ns, DATA.context, ctx);
      if (Date.now() - lastMetricsLine > 60_000) {
        lastMetricsLine = Date.now();
        appendJsonl(ns, DATA.metrics, { ...metricsLine(s, m, hackStatus, current, build), systems: systemsLine(ns) }, 1500);
      }
      draw(ns, s, m, hackStatus, current, recent);
    }

    await ns.sleep(cfg.tickMs);
  }
}

/** Kill everything on home except the daemon (before install/destroy, which wipe scripts anyway). */
let lastReserve = 0;
/** factions that offer work (bribes and donations need that) */
let workableFactions = new Set<string>();
/** latest skills and sleeve shock, for the per-minute metrics line */
let lastSkills: Record<string, number> = {};
let lastSleeveShock: number | null = null;

/** First time each milestone happens this BitNode → data/milestones.txt and the node summary. */
function noteMilestones(ns: NS, data: FactionData, s: Snapshot, event: (k: string, msg: string, d?: unknown) => void) {
  const bb = readJson<{ inDivision?: boolean }>(ns, DATA.bladeburner, {});
  const stocks = readJson<{ access?: { api4s?: boolean } }>(ns, DATA.stocks, {});
  const corp = readJson<{ exists?: boolean }>(ns, DATA.corp, {});
  const has = (a: string) => data.installed.includes(a);
  const wd = data.worldDaemon;
  const reached: Record<string, boolean> = {
    "casino $10b": (s.earned.casino ?? 0) >= CASINO_CAP,
    "Stanek's Gift accepted": has(GENESIS),
    "gang created": !!s.gang,
    "Bladeburner division": bbInDivision || bb.inDivision === true,
    "The Blade's Simulacrum": has(SIMULACRUM),
    "Bladeburners faction": !!data.factions.Bladeburners?.joined,
    "Stanek's Gift - Awakening": has("Stanek's Gift - Awakening"),
    "Stanek's Gift - Serenity": has("Stanek's Gift - Serenity"),
    "Daedalus joined": !!data.factions.Daedalus?.joined,
    "The Red Pill installed": has("The Red Pill"),
    "w0r1d_d43m0n hack level": wd.exists && data.hackLevel >= wd.reqHack,
    "4S TIX API": stocks.access?.api4s === true,
    "corporation created": corp.exists === true,
  };
  const st = readJson<DaemonState | null>(ns, STATE_FILE, null);
  if (!st) return;
  // started tracking mid-node: what's already true gets today's time, flagged as such
  const backfilled = st.milestones === undefined;
  st.milestones ??= {};
  let changed = backfilled;
  for (const [name, ok] of Object.entries(reached)) {
    if (!ok || name in st.milestones) continue;
    const since = Date.now() - s.lastNodeReset;
    st.milestones[name] = since;
    changed = true;
    appendJsonl(ns, DATA.milestones, { t: Date.now(), node: data.node, name, sinceNodeMs: since, installs: st.nodeInstalls ?? 0, backfilled });
    if (!backfilled) event("milestone", `${name} after ${dur(since)}`);
  }
  if (changed) writeJson(ns, STATE_FILE, st);
}

/** Per-minute snapshot of every subsystem (from their status files) for data/metrics.txt. */
function systemsLine(ns: NS) {
  // status files survive resets: only trust ones written recently (a stopped manager's is stale)
  const recent = <T extends { t?: number }>(file: string): Partial<T> => {
    const x = readJson<Partial<T>>(ns, file, {});
    return x.t && Date.now() - x.t < 5 * 60_000 ? x : {};
  };
  const bb = recent<{ t: number; inDivision: boolean; rank: number; rankPerSec: number; finalEtaSec: number | null }>(DATA.bladeburner);
  const gang = recent<{ t: number; respect: number; territory: number; members: number; mode: string; installFactor: number }>(DATA.gang);
  const corp = recent<{ t: number; exists: boolean; funds: number; revenue: number; expenses: number; public: boolean }>(DATA.corp);
  const stocks = recent<{ t: number; mode: string; value: number; realized: number; pre: { edge?: number } }>(DATA.stocks);
  const hn = recent<{ t: number; servers: number; production: number }>(DATA.hacknet);
  return {
    bladeburner: bb.inDivision ? { rank: bb.rank, rankPerSec: bb.rankPerSec, finalEtaSec: bb.finalEtaSec } : null,
    gang: gang.members ? { respect: gang.respect, territory: gang.territory, members: gang.members, mode: gang.mode, installFactor: gang.installFactor } : null,
    stanek: stanekStatus ? { bonus: stanekStatus.bonus, charger: stanekStatus.charger?.mode ?? null, extras: stanekStatus.extraChargers.length } : null,
    corp: corp.exists ? { funds: corp.funds, profit: (corp.revenue ?? 0) - (corp.expenses ?? 0), public: corp.public } : null,
    stocks: stocks.mode ? { mode: stocks.mode, value: stocks.value, realized: stocks.realized, preEdge: stocks.pre?.edge } : null,
    hacknet: hn.servers ? { servers: hn.servers, production: hn.production } : null,
    skills: lastSkills,
    sleeveShock: lastSleeveShock,
  };
}
let runRateCache: { t: number; rate: number | null } = { t: 0, rate: null };

/**
 * Average aug value per second of the last 5 runs this BitNode: each run (data/runs.txt) valued by the
 * augs its install event bought (data/events.txt), with the planner's own aug values.
 */
function recentRunRate(ns: NS, data: FactionData, cfg: PlanConfig, nodeStart: number): number | null {
  if (Date.now() - runRateCache.t < 5 * 60_000) return runRateCache.rate;
  const jsonl = <T,>(file: string): T[] =>
    ns
      .read(file)
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as T];
        } catch {
          return [];
        }
      });
  // this BitNode only: runs late in an earlier node (many NeuroFlux levels, bigger augs) aren't comparable
  const runs = jsonl<RunRecord>(DATA.runs).filter((r) => r.t > nodeStart + 60_000);
  const installs = jsonl<{ t: number; kind: string; msg: string; data?: { bought?: string[]; nfg?: number } }>(DATA.events)
    .filter((e) => e.kind === "install" && e.msg.startsWith("installing ") && e.data?.bought)
    .map((e) => ({ t: e.t, bought: e.data!.bought!, nfg: e.data!.nfg ?? 0 }));
  const weights = routeWeights(data, cfg.weights);
  const valueOf = (a: string) => augValue(data.augs[a]?.stats ?? {}, weights) + (cfg.augBonus[a] ?? 0);
  const valued = valueRuns(runs, installs, valueOf, augValue(data.augs[NFG]?.stats ?? {}, weights));
  runRateCache = { t: Date.now(), rate: averageRate(valued) };
  return runRateCache.rate;
}

/** Home RAM picture for the status file: what each task costs, who uses home, the reserve. */
function ramReport(ns: NS) {
  const procs = ns.ps("home").map((p) => ({ file: p.filename, threads: p.threads, gb: ns.getScriptRam(p.filename, "home") * p.threads }));
  const byFile = new Map<string, number>();
  for (const p of procs) byFile.set(p.file, (byFile.get(p.file) ?? 0) + p.gb);
  const tasks = Object.fromEntries(
    ns
      .ls("home", "tasks/")
      .filter((f) => f.endsWith(".js"))
      .map((f) => [f, ns.getScriptRam(f, "home")]),
  );
  const proxies = Object.fromEntries(
    ns
      .ls("home", "tmp/call/")
      .filter((f) => f.endsWith(".js"))
      .map((f) => [f.replace("tmp/call/", ""), ns.getScriptRam(f, "home")])
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .slice(0, 12),
  );
  return {
    home: ns.getServerMaxRam("home"),
    used: ns.getServerUsedRam("home"),
    reserve: lastReserve,
    daemon: ns.getScriptRam(SCRIPTS.daemon, "home"),
    users: [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([file, gb]) => ({ file, gb: Math.round(gb * 10) / 10 })),
    tasks,
    proxies,
  };
}

function freeHome(ns: NS): void {
  for (const proc of ns.ps("home")) if (proc.pid !== ns.pid) ns.kill(proc.pid);
}

/** Tasks that only run right before a reset; they get RAM by freeing home instead of a permanent reserve. */
// contracts.js too: it isn't time-critical, so it runs whenever there's spare RAM instead of
// holding 24 GB of home back permanently
const ONE_OFF_TASKS = ["tasks/install.js", "tasks/destroy.js", "tasks/contracts-selftest.js", "tasks/restart.js", "tasks/contracts.js"];

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

/** A graft owns the player's work (the task is traveling, grafting, or waiting for the game). */
function graftingRunning(ns: NS, s?: Snapshot): boolean {
  return s?.work?.type === "GRAFTING" || ns.ps("home").some((p) => p.filename === SCRIPTS.graft);
}

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
function casinoModule(
  ns: NS,
  s: Snapshot,
  m: Metrics,
  event: (k: string, msg: string, d?: unknown) => void,
): { key: string; msg: string } | null {
  // null = nothing worth logging (claimed, betting, or the one-minute warm-up)
  if (ns.isRunning(SCRIPTS.casinoTable, "home")) return null;
  if ((s.earned.casino ?? 0) >= CASINO_CAP) return null;
  if (graftingRunning(ns, s)) return { key: "graft", msg: "waiting, a graft owns the player" };
  // it could at most double what we already hold
  if (s.money >= CASINO_CAP) return { key: "rich", msg: `skipped, already holding ${money(s.money)}` };
  // don't trust an empty window: give the rate trackers a minute after (re)start.
  // (The long window: the short one spans *at most* 60 s, so testing it for >= 60 s only
  // passed by timing luck and the casino started 7-72 min into a node instead of ~2.)
  if (m.long.spanMs < 60_000) return null;
  const hackRate = readJson<{ expectedPerSec?: number }>(ns, DATA.hackStatus, {}).expectedPerSec ?? 0;
  const gangRate = (s.gang?.moneyRate ?? 0) * 5; // moneyGainRate is per 200 ms gang cycle
  const income = Math.max(m.short.income, m.long.income, gangRate + hackRate);
  if (income * 1800 >= CASINO_CAP) return { key: "income", msg: `skipped, income ${money(income)}/s makes $10b within 30 min` };
  const last = readJson<{ lastAugReset?: number; msg?: string }>(ns, DATA.casino, {});
  if (last.lastAugReset === s.lastAugReset) return { key: "tried", msg: `not retried this install (${last.msg ?? "already attempted"})` };
  if (ns.exec(SCRIPTS.casino, "home")) {
    event("casino", "started blackjack save-scummer for the $10b casino allowance");
    return null;
  }
  return { key: "ram", msg: "waiting, no free RAM on home for casino.js" };
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
async function gangModule(
  ns: NS,
  data: FactionData,
  p: Plan,
  dcfg: DaemonConfig,
  event: (k: string, msg: string, d?: unknown) => void,
  sinceInstallMs = 0,
) {
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
  // time to the next install: now if one is planned, else the median recent run minus this one
  const runs = ns.read(DATA.runs).split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { durationMs?: number }).durationMs ?? 0);
  // past the typical run length there's no sign of an install coming: don't hold (undefined)
  const left = expectedRunMs(runs, 30 * 60_000) - sinceInstallMs;
  const installInSec = p.install ? 0 : left > 0 ? left / 1000 : undefined;
  const gcfg: Partial<GangConfig> = { mode: needRep ? "respect" : "money", installInSec, ...dcfg.gang };
  // no equipment shopping while casino.js is betting or cash is reserved for RAM/The Red Pill
  if (ns.isRunning(SCRIPTS.casinoTable, "home") || p.shareAll || p.redPillPush)
    Object.assign(gcfg, { equipBudget: 0, augBudget: 0 });
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
let lastGraftEval = 0;
let lastGraftLog = 0;
let lastCompanyLog = 0;
let lastCompanyKey = "";
/** latest grafting evaluation (dashboard) */
let graftTop: GraftRow | null = null;

/**
 * Value each graftable aug against one Entropy stack and its graft time, next to the faction
 * route's ETA. Auto-graft the best one that clears the net, time, cash and cumulative-Entropy
 * caps; log the full evaluation to data/grafting.txt every 10 min.
 */
async function graftingModule(
  ns: NS,
  data: FactionData,
  p: Plan,
  dcfg: DaemonConfig,
  cfg: PlanConfig,
  cash: number,
  busy: boolean,
  active: boolean,
  event: (k: string, msg: string, d?: unknown) => void,
): Promise<boolean> {
  if (active) return true;
  const gcfg: GraftingConfig = { ...DEFAULT_GRAFTING, ...dcfg.grafting };
  if (!gcfg.auto && !dcfg.logGrafting) return false;
  if (!((data.sourceFiles["10"] ?? 0) > 0 || data.node === 10)) return false;
  // the first aug forever blocks Stanek's Gift; let manageStanek accept it first
  const stanekPending =
    (data.sourceFiles["13"] ?? 0) > 0 &&
    (dcfg.stanek?.enabled ?? DEFAULT_STANEK.enabled) &&
    !data.installed.includes("Stanek's Gift - Genesis") &&
    [...data.installed, ...data.queued].every((a) => a === NFG);
  if (stanekPending) return false;
  if (Date.now() - lastGraftEval < (gcfg.auto ? 5 * 60_000 : 10 * 60_000)) return false;
  lastGraftEval = Date.now();
  const all = (await call<string[]>(ns, "grafting.getGraftableAugmentations")) ?? [];
  const unknown = all.filter((a) => !data.augs[a]);
  const extra = await callEach<Record<string, number>>(ns, "singularity.getAugmentationStats", unknown.map((a) => [a]));
  const prereqs = await callEach<string[]>(ns, "singularity.getAugmentationPrereq", unknown.map((a) => [a]));
  const statsOf = new Map(unknown.map((a, k) => [a, extra[k] ?? {}]));
  const prereqOf = new Map(unknown.map((a, k) => [a, prereqs[k] ?? []]));
  // getGraftableAugmentations ignores prerequisites, so a graft can still be rejected
  const installed = new Set(data.installed);
  const augs = all.filter((a) => (data.augs[a]?.prereqs ?? prereqOf.get(a) ?? []).every((p) => installed.has(p)));
  const one = augs.map((a) => [a]);
  const prices = await callEach<number>(ns, "grafting.getAugmentationGraftPrice", one);
  const times = await callEach<number>(ns, "grafting.getAugmentationGraftTime", one);
  // the faction route this run: ready now (0), rep-gated (its ETA), or none (null)
  const eta = new Map<string, number>();
  for (const c of p.ready) eta.set(c.aug, 0);
  for (const c of p.pending) eta.set(c.aug, Number.isFinite(c.repEta) ? c.repEta : 1e9);
  const entropy = (await call<{ entropy: number }>(ns, "getPlayer"))?.entropy ?? 0;
  const hasCongruity = data.installed.includes(CONGRUITY);
  const weights = routeWeights(data, cfg.weights);
  const rows = evaluateGrafts(
    augs.map((a, k) => ({
      aug: a,
      price: prices[k] ?? Infinity,
      timeMs: times[k] ?? Infinity,
      stats: data.augs[a]?.stats ?? statsOf.get(a) ?? {},
      factionEtaSec: eta.has(a) ? eta.get(a)! : null,
    })),
    weights,
    { hasCongruity, entropy, bonus: cfg.augBonus },
  );
  graftTop = rows[0] ?? null;
  const reserve = gcfg.moneyReserve + (data.node === 12 && !data.factions.Daedalus?.joined ? DAEDALUS_MONEY : 0);
  const choice = gcfg.auto
    ? chooseGraft(
        rows,
        { ...gcfg, moneyReserve: reserve },
        {
          money: cash,
          installPlanned: !!p.install || p.shareAll || p.redPillPush || p.postRedPill,
          owned: data.installed,
          queued: data.queued,
        },
      )
    : null;
  const started = !!choice && !busy && spawnTask(ns, SCRIPTS.graft, [choice.aug, gcfg.focus]) > 0;
  if (started) {
    event(
      "graft",
      `started grafting ${choice!.aug}: net ${choice!.net.toFixed(2)} (${choice!.netPerHour.toFixed(3)}/h) in ${choice!.hours.toFixed(1)}h, Entropy ${entropy} → ${choice!.entropyAfter}`,
      { aug: choice!.aug, price: choice!.price, hours: choice!.hours, net: choice!.net, entropy, entropyAfter: choice!.entropyAfter },
    );
  }
  if (Date.now() - lastGraftLog >= 10 * 60_000) {
    lastGraftLog = Date.now();
    const work = p.work?.faction;
    appendJsonl(
      ns,
      DATA.grafting,
      {
        t: Date.now(),
        entropy,
        entropyCost: hasCongruity ? 0 : entropyCost(weights),
        hasCongruity,
        money: cash,
        reserve,
        workRepPerSec: work ? (data.factions[work]?.workRepPerSec ?? 0) : 0,
        graftable: augs.length,
        choice: choice?.aug ?? null,
        started,
        rows: rows.slice(0, 25),
      },
      200,
    );
  }
  return started;
}

let infilEstimate: { t: number; repPerSec: number; target: string } = { t: 0, repPerSec: 0, target: "" };

/**
 * Infiltrate for the faction the planner is grinding when it beats faction work: the best
 * location's rep/s (measured runs, else the info API) vs. that faction's work rep/s × margin.
 * Not during the casino or Bladeburner training, and not within 10 min of a failed run.
 * Returns true while infiltrate.js runs (it owns the UI and the player's time).
 */
async function infiltrationModule(
  ns: NS,
  data: FactionData,
  p: Plan,
  dcfg: DaemonConfig,
  casinoBetting: boolean,
  event: (k: string, msg: string, d?: unknown) => void,
): Promise<boolean> {
  // by process list: it runs with the faction as its argument, so isRunning(script, host)
  // without args never matched it and a second copy was started next to the first
  const running = ns.ps("home").some((x) => x.filename === SCRIPTS.infiltrate);
  const cfg: InfiltrationConfig = { ...DEFAULT_INFILTRATION, ...dcfg.infiltration };
  const faction = p.work?.faction ?? null;
  const st = readJson<Partial<InfiltrationState>>(ns, DATA.infiltration, {});
  let active = false;
  if (dcfg.manageInfiltration && faction && !casinoBetting && !p.train) {
    if (Date.now() - infilEstimate.t > 5 * 60_000) {
      const locs = ns.infiltration.getPossibleLocations();
      const infos = await callEach<{
        difficulty: number;
        maxClearanceLevel: number;
        startingSecurityLevel: number;
        reward: { tradeRep: number; sellCash: number };
      }>(
        ns,
        "infiltration.getInfiltration",
        locs.map((l) => [l.name]),
      );
      const targets = locs.flatMap((l, k) => {
        const i = infos[k];
        return i
          ? [{ name: l.name, city: l.city, difficulty: i.difficulty, levels: i.maxClearanceLevel, tradeRep: i.reward.tradeRep, sellCash: i.reward.sellCash, startingSecurity: i.startingSecurityLevel }]
          : [];
      });
      const hp = (await call<{ hp: { current: number } }>(ns, "getPlayer"))?.hp.current ?? 0;
      const best = chooseTarget(targets, st.measured ?? {}, cfg, { current: hp, harmonizer: data.installed.includes("SoA - phyzical WKS harmonizer") });
      infilEstimate = { t: Date.now(), repPerSec: best?.repPerSec ?? 0, target: best?.target.name ?? "" };
    }
    const workRate = data.factions[faction]?.workRepPerSec ?? 0;
    // back off: 10 min after a failed run, doubling per failure in a row (max 2 h)
    const failedRecently = st.lastRun && !st.lastRun.ok && Date.now() - (st.t ?? 0) < cooldownAfter(st.consecutiveFailures ?? 1, cfg);
    active = !failedRecently && infilEstimate.repPerSec > workRate * cfg.margin;
  }
  const ctl: InfiltrationControl = { active, faction, cfg: dcfg.infiltration };
  writeJson(ns, DATA.infiltrationConfig, ctl);
  if (active && !running && ns.exec(SCRIPTS.infiltrate, "home", 1, faction!))
    event(
      "infiltration",
      `infiltrating ${infilEstimate.target} for ${faction}: ~${num(infilEstimate.repPerSec)} rep/s vs ${num(data.factions[faction!]?.workRepPerSec ?? 0)} working`,
    );
  return running || (active && ns.ps("home").some((x) => x.filename === SCRIPTS.infiltrate));
}

/** true once we've joined the Bladeburner division (this BitNode) */
let bbInDivision = false;

/** Joining is safe once Stanek's Gift is accepted, or can't/won't be (see bladeburnerModule). */
function bladeburnerCanJoin(data: FactionData, dcfg: DaemonConfig): boolean {
  if (!dcfg.manageBladeburner || (!(data.sourceFiles["7"] > 0) && data.node !== 7)) return false;
  return data.installed.includes(GENESIS) || (stanekStatus !== null && stanekStatus.state !== "accepted");
}

function stopManager(ns: NS, script: string): void {
  for (const p of ns.ps("home")) if (p.filename === script) ns.kill(p.pid);
}

async function bladeburnerModule(
  ns: NS,
  data: FactionData,
  p: Plan,
  dcfg: DaemonConfig,
  playerBusy: boolean,
  event: (k: string, msg: string, d?: unknown) => void,
) {
  bladeburnerWanted = false;
  if (!dcfg.manageBladeburner) {
    stopManager(ns, SCRIPTS.bladeburnerManager);
    return;
  }
  if (!(data.sourceFiles["7"] > 0) && data.node !== 7) return; // no API access
  const stanekSettled = bladeburnerCanJoin(data, dcfg);
  const ctl: BladeburnerControl = { canJoin: stanekSettled, usePlayer: p.bladeburner && !playerBusy, cfg: dcfg.bladeburner };
  // join as soon as the stats allow, even before home can hold the manager: the Simulacrum
  // (SF7.3) and rank both start then. One-off proxy call, 4 GB for a moment.
  const combat = ["strength", "defense", "dexterity", "agility"].every((k) => (data.skills[k] ?? 0) >= 100);
  if (stanekSettled && combat && !bbInDivision) {
    bbInDivision = (await call<boolean>(ns, "bladeburner.joinBladeburnerDivision")) === true;
    if (bbInDivision) event("bladeburner", "joined the Bladeburner division");
  }
  writeJson(ns, DATA.bladeburnerConfig, ctl);
  if (!stanekSettled || ns.getServerMaxRam("home") < dcfg.bladeburnerMinHomeGB) {
    stopManager(ns, SCRIPTS.bladeburnerManager);
    return;
  }
  if (ns.isRunning(SCRIPTS.bladeburnerManager, "home")) {
    bladeburnerWanted = true;
    return;
  }
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
  const r = m.long.spanMs >= 120_000 ? m.long : m.short;
  const work = s.work as { factionName?: string } | null;
  const p = makePlan(
    {
      data,
      observedRep: r.rep,
      income: r.income,
      sinceInstall: m.sinceInstall,
      currentWork: work?.factionName ?? null,
      ratesReady: m.long.spanMs >= 120_000,
      avgRunRate: recentRunRate(ns, data, cfg, s.lastNodeReset),
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
    writeJson(ns, DATA.destroyContext, { t: Date.now(), route: bbWon ? "bladeburner" : "hacking", node: data.node });
    freeHome(ns);
    spawnTask(ns, "tasks/destroy.js", [cfg.nextNode]);
    return p;
  }

  const act: ActArgs = {
    join: p.join,
    travelTo: p.travelTo,
    work: p.work,
    crime: p.crime,
    buyNow: p.buyNow,
    train: p.train,
    company: p.company,
    study: p.study,
  };
  // casino.js drives the UI (blackjack table); work/travel would navigate away from it
  const casinoBetting = ns.isRunning(SCRIPTS.casinoTable, "home");
  const graftActive = graftingRunning(ns, s);
  const infiltrating = await infiltrationModule(ns, data, p, dcfg, casinoBetting || graftActive, event);
  // casino.js / infiltrate.js drive the UI, and a graft owns the player's time
  let busy = casinoBetting || infiltrating || graftActive;
  const stopActions = () => {
    act.work = null;
    act.crime = null;
    act.travelTo = null;
    act.train = null;
    act.company = null;
    act.study = null;
  };
  if (busy) stopActions();
  // the planner is stateless; a cooldown stops it from bouncing between cities
  if (act.travelTo) {
    if (Date.now() - lastTravel < TRAVEL_COOLDOWN_MS) act.travelTo = null;
    else lastTravel = Date.now();
  }
  // don't fight the player over work while a gang/crime module isn't steering it
  if (!cfg.manageWork) {
    act.work = null;
    act.crime = null;
    act.company = null;
    act.study = null;
  }
  // company-route data, every 5 min (or on a change): is company work the better path?
  const routeKey = `${p.company?.company ?? ""}|${p.companyRoutes[0]?.faction ?? ""}`;
  if (Date.now() - lastCompanyLog > 5 * 60_000 || routeKey !== lastCompanyKey) {
    lastCompanyLog = Date.now();
    lastCompanyKey = routeKey;
    appendJsonl(ns, DATA.company, { t: Date.now(), chosen: p.company, grindScore: p.grindScore, routes: p.companyRoutes, companies: data.companies }, 300);
  }
  if (dcfg.manageGang) await gangModule(ns, data, p, dcfg, event, m.sinceInstall);

  // Stanek before anything can buy an aug: the gift can only be accepted with no augs
  try {
    stanekStatus = await manageStanek(ns, data, s.homeCores, { ...DEFAULT_STANEK, ...dcfg.stanek }, event, homeReserve(ns),
      (p.repGated[CHURCH] ?? 0) > 0, // Church augs still need rep → extra chargers
    );
  } catch (e) {
    event("error", `stanek failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  await bladeburnerModule(ns, data, p, dcfg, busy, event);
  const graftStarted = await graftingModule(ns, data, p, dcfg, cfg, s.money, busy, graftActive, event);
  if (graftStarted) {
    busy = true;
    stopActions();
  }
  lastSkills = Object.fromEntries(Object.entries(data.skills).map(([k, v]) => [k, Math.round(v)]));
  workableFactions = new Set(Object.keys(data.factions).filter((f) => data.factions[f].workTypes.length > 0));
  noteMilestones(ns, data, s, event);

  // sleeves first: the game allows one sleeve alongside the player on the same faction
  if (dcfg.manageSleeves && s.sleeves > 0) {
    try {
      const targets = p.grindFactions;
      const runDurations = ns
        .read(DATA.runs)
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { durationMs?: number }).durationMs ?? 0);
      const runLeft = expectedRunMs(runDurations, 30 * 60_000) - m.sinceInstall;
      const needKarma = shouldFarmKarma({
        hasGang: !!data.gangFaction,
        karma: data.karma,
        karmaTarget: GANG_KARMA,
        timeToGangMs: m.timeToGang,
        runLeftMs: runLeft,
      });
      const rep = await manageSleeves(
        ns,
        data,
        targets,
        p.favorFactions,
        needKarma,
        busy || p.shareAll || p.redPillPush ? 0 : undefined, // no sleeve augs while cash is reserved for RAM/The Red Pill
        {
          recovery: { ...DEFAULT_RECOVERY, ...dcfg.sleeveRecovery },
          bladeburner: bbInDivision && readJson<Partial<BladeburnerStatus>>(ns, DATA.bladeburner, {}).blackOpsDone !== true,
        },
      );
      lastSleeveShock = rep.rows.length ? rep.rows.reduce((a, r) => a + r.shock, 0) / rep.rows.length : null;
      // shock-recovery experiment: one line per minute (tools/sleeve-shock.mjs to analyse later)
      if (Date.now() - lastSleeveLog > 60_000) {
        lastSleeveLog = Date.now();
        appendJsonl(ns, DATA.sleeves, { t: Date.now(), sleeves: rep.rows, observedRep: m.short.rep, sleeveIncome: m.short.bySource.sleeves ?? 0 }, 1500);
      }
      for (const c of rep.changed) event("sleeve", c);
      if (rep.augsBought) event("sleeve", `bought ${rep.augsBought} sleeve augmentation(s)`);
      sleeveSummary = summarizeSleeves(rep.assignments);
    } catch (e) {
      event("error", `sleeves failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  try {
    for (const d of await doActions(ns, act, data.city)) event("faction", d);
  } catch (e) {
    // CallError = no RAM for a proxy right now: try again next tick
    if (!(e instanceof CallError)) event("error", `faction actions failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!busy && p.backdoor.length && spawnTask(ns, "tasks/backdoor.js", [p.backdoor[0]]))
    event("backdoor", `installing backdoor on ${p.backdoor[0]}`);

  if (p.install && !busy) {
    event("install", `install planned: ${p.install.reason}`, {
      buy: p.install.buy.map(([, a]) => a),
      cost: p.readyCost,
      sinceInstall: m.sinceInstall,
      money: s.money,
    });
    // for the run record: why, the install-timing rates, and what each aug is worth
    const weights = routeWeights(data, cfg.weights);
    const valueOf = (a: string) => augValue(data.augs[a]?.stats ?? {}, weights) + (cfg.augBonus[a] ?? 0);
    writeJson(ns, DATA.installContext, {
      t: Date.now(),
      reason: p.install.reason,
      rates: p.installRates,
      augValues: Object.fromEntries(p.install.buy.map(([, a]) => [a, valueOf(a)])),
      nfgValue: valueOf(NFG),
    });
    freeHome(ns);
    spawnTask(ns, "tasks/install.js", [JSON.stringify(p.install)]);
  }
  return p;
}

function metricsLine(s: Snapshot, m: Metrics, hackInfo: HackInfo, p: Plan | null, build: string) {
  const r = m.long.spanMs >= 120_000 ? m.long : m.short;
  return {
    t: s.t,
    build,
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
    hackExpected: hackInfo.expectedPerSec ?? 0,
    /** free GB the hacking manager found at the start of its tick (not the pool's size: see `ram`) */
    ramPool: hackInfo.poolTotal ?? 0,
    /** rooted GB by kind, GB in use on managed hosts, and GB the manager may use */
    ram: hackInfo.ramBy ? { ...hackInfo.ramBy, managedGB: hackInfo.managedRam ?? 0 } : null,
    shareThreads: hackInfo.shareThreads ?? 0,
    shareOnly: hackInfo.shareOnly === true,
    shareMult: s.shareMult ?? null,
    homeRam: s.homeRam,
    work: s.work?.type ?? null,
    plan: p ? planLine(p) : null,
  };
}

/** The planner's install/budget inputs, per minute: enough to replay a timing rule offline. */
function planLine(p: Plan) {
  const fin = (x: number) => (Number.isFinite(x) ? x : null);
  return {
    ready: p.ready.length,
    readyValue: p.readyValue,
    readyCost: p.readyCost,
    marginal: p.installRates.marginal,
    average: p.installRates.average,
    own: p.installRates.own,
    nextEta: fin(p.nextEta),
    install: p.install?.reason ?? null,
    hold: p.installHold?.key ?? null,
    infraSpend: p.infraSpend,
    infraBudget: p.infraBudget,
    augReserve: fin(p.augReserve),
    moneyBound: p.moneyBound,
    repBound: p.repBound,
    shareAll: p.shareAll,
    redPillPush: p.redPillPush,
    grind: p.work?.faction ?? p.company?.company ?? null,
    hackXp: p.hackXp?.level ?? null,
    redPill: p.redPill,
  };
}

function freshRun(s: Snapshot, start = s.lastAugReset): DaemonState["cur"] {
  const rep = sumNumbers(s.rep);
  return {
    lastT: s.t,
    gapMs: 0,
    nodeLevel: (s.sourceFiles[String(s.node)] ?? 0) + 1,
    builds: [],
    start,
    peakIncome: 0,
    peakRepRate: 0,
    hackLevel: s.hackLevel,
    augsInstalled: s.augsInstalled,
    startMoney: s.money,
    lastMoney: s.money,
    peakMoney: s.money,
    startHackLevel: s.hackLevel,
    startHackExp: s.hackExp,
    lastHackExp: s.hackExp,
    startRepTotal: rep,
    lastRepTotal: rep,
    lastEarned: { ...s.earned },
  };
}

/** Sum the numeric values of an earnings object (MoneySource or accumulated node totals). */
function sumNumbers(o: object | undefined): number {
  return o ? Object.values(o).reduce<number>((a, v) => a + (typeof v === "number" ? v : 0), 0) : 0;
}

/** MoneySource has both its categories and a `total`; prefer the total to avoid double counting. */
function earnedTotalOf(o: object | undefined): number {
  const total = (o as { total?: unknown } | undefined)?.total;
  return typeof total === "number" ? total : sumNumbers(o);
}

function addEarned(total: Record<string, number>, run: Snapshot["earned"]): Record<string, number> {
  const out = { ...total };
  for (const [k, v] of Object.entries(run)) out[k] = (out[k] ?? 0) + v;
  return out;
}

/** Last install run in this BitNode before `before`, for the per-run comparison. */
function previousInstallRun(ns: NS, node: number, before: number, after: number): RunRecord | null {
  const lines = ns.read(DATA.runs).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    try {
      const r = JSON.parse(lines[i]) as RunRecord;
      if (r.node === node && r.kind !== "node" && r.t < before && r.t >= after && r.durationMs > 0) return r;
    } catch {
      /* ignore a torn line */
    }
  }
  return null;
}

/** Detect augment installs / node resets and write one summary line per finished run. */
function trackRuns(ns: NS, s: Snapshot, tracker: MetricsTracker, event: (k: string, m: string, d?: unknown) => void, build: string) {
  const st = readJson<(DaemonState & { run?: DaemonState["cur"] }) | null>(ns, STATE_FILE, null);
  const m = tracker.metrics();
  const r = m.long.spanMs >= 120_000 ? m.long : m.short;
  // migrate older state files (the field used to be called `run`) and repair partial ones
  if (st && !st.cur) {
    // bracket access: a bare `.run` would cost 1 GB (it matches ns.run in the RAM calculator)
    st.cur = st["run"] ?? freshRun(s, st.lastAugReset ?? s.lastAugReset);
    delete st["run"];
  }
  if (!st || typeof st.lastAugReset !== "number") {
    writeJson(ns, STATE_FILE, {
      lastAugReset: s.lastAugReset,
      lastNodeReset: s.lastNodeReset,
      installs: 0,
      cur: freshRun(s),
    } satisfies DaemonState);
    return;
  }
  // state written before the extra run fields: start them from the current snapshot
  const cur = st.cur;
  cur.startMoney ??= s.money;
  cur.lastMoney ??= s.money;
  cur.peakMoney ??= s.money;
  cur.startHackLevel ??= s.hackLevel;
  cur.startHackExp ??= s.hackExp;
  cur.lastHackExp ??= s.hackExp;
  cur.startRepTotal ??= sumNumbers(s.rep);
  cur.lastRepTotal ??= cur.startRepTotal;
  cur.lastEarned ??= { ...s.earned };
  cur.nodeLevel ??= (s.sourceFiles[String(s.node)] ?? 0) + 1;
  cur.builds ??= [];
  if (build && cur.builds[cur.builds.length - 1] !== build) cur.builds.push(build);
  st.nodeBuilds ??= [];
  if (build && !st.nodeBuilds.includes(build)) st.nodeBuilds.push(build);

  // untracked time: the game was closed (it catches up as bonus time) or the daemon was down.
  // Either way the rates and durations around it are not comparable with tracked play.
  const gap = cur.lastT ? s.t - cur.lastT : 0;
  if (gap > GAP_MS) {
    // a gap that spans a reset belongs to the run that just ended, up to the reset
    const inRun = st.lastAugReset !== s.lastAugReset ? Math.max(0, s.lastAugReset - cur.lastT!) : gap;
    cur.gapMs = (cur.gapMs ?? 0) + inRun;
    st.nodeGapMs = (st.nodeGapMs ?? 0) + inRun;
    event("gap", `nothing tracked for ${dur(gap)} (game closed or daemon down)`, { from: cur.lastT, to: s.t, ms: gap });
  }
  cur.lastT = s.t;

  if (st.lastAugReset !== s.lastAugReset) {
    const nodeReset = st.lastNodeReset !== s.lastNodeReset;
    // what the install bought and why (files written just before it; only if they're this run's)
    const fresh = <T extends { t?: number }>(x: T) => (x.t ?? 0) >= cur.start;
    const bought = readJson<{
      t?: number;
      bought?: string[];
      nfg?: number;
      queued?: number;
      reason?: string;
      spent?: number;
      moneyBefore?: number;
      moneyAfter?: number;
    }>(ns, DATA.lastInstall, {});
    const ictx = readJson<{ t?: number; reason?: string; rates?: unknown; augValues?: Record<string, number>; nfgValue?: number }>(ns, DATA.installContext, {});
    const got = fresh(bought) ? bought : {};
    const vals = fresh(ictx) ? ictx : {};
    const installSpent = got.spent ?? 0;
    const value =
      got.bought && vals.augValues
        ? got.bought.reduce((a, aug) => a + (vals.augValues![aug] ?? 0), 0) + (got.nfg ?? 0) * (vals.nfgValue ?? 0)
        : undefined;

    // values from the last pre-install tick: the snapshot that detected the reset is already post-install
    const durationMs = s.lastAugReset - cur.start;
    const durationSec = durationMs / 1000;
    const startMoney = cur.startMoney ?? s.money;
    const endMoney = cur.lastMoney ?? s.money;
    const earned = cur.lastEarned ?? s.earned;
    const earnedTotal = earnedTotalOf(earned);
    const spent = startMoney + earnedTotal - endMoney;
    const startHackExp = cur.startHackExp ?? s.hackExp;
    const endHackExp = cur.lastHackExp ?? startHackExp;
    const hackExpGained = Math.max(0, endHackExp - startHackExp);
    const hackExpPerSec = durationSec > 0 ? hackExpGained / durationSec : 0;
    const startHackLevel = cur.startHackLevel ?? cur.hackLevel;
    const hackLevelGain = Math.max(0, cur.hackLevel - startHackLevel);
    const startRep = cur.startRepTotal ?? sumNumbers(s.rep);
    const endRep = cur.lastRepTotal ?? startRep;
    const repGained = Math.max(0, endRep - startRep);
    const repPerSec = durationSec > 0 ? repGained / durationSec : 0;
    const incomePerSec = durationSec > 0 ? earnedTotal / durationSec : 0;
    const valueRate = value != null && durationSec > 0 ? value / durationSec : undefined;
    const vsPrev = compareRun(
      { durationMs, earnedTotal, incomePerSec, hackExpPerSec, valueRate },
      previousInstallRun(ns, s.node, s.t, s.lastNodeReset),
    );

    appendJsonl(ns, DATA.runs, {
      t: s.t,
      kind: nodeReset ? "node" : "install",
      node: s.node,
      nodeLevel: cur.nodeLevel,
      build,
      builds: cur.builds,
      runIndex: st.installs + 1,
      nodeRun: (st.nodeInstalls ?? 0) + 1,
      startedAt: cur.start,
      durationMs,
      gapMs: cur.gapMs ?? 0,
      trackedMs: Math.max(0, durationMs - (cur.gapMs ?? 0)),
      ramStart: cur.startRam,
      ramEnd: cur.lastRam,
      hashes: cur.hashes?.total,
      hashProduction: cur.hashProduction?.total,
      hashRateEnd: cur.lastHashRate,
      nodeElapsedMs: s.t - st.lastNodeReset,
      moneyStart: startMoney,
      moneyEnd: endMoney,
      earned,
      earnedTotal,
      spent,
      installMoneyBefore: got.moneyBefore,
      installMoneyAfter: got.moneyAfter,
      installSpent: got.spent,
      installQueued: got.queued,
      hackLevelStart: startHackLevel,
      hackLevelEnd: cur.hackLevel,
      hackLevelGain,
      hackExpStart: startHackExp,
      hackExpEnd: endHackExp,
      hackExpGained,
      hackExpPerSec,
      repStart: startRep,
      repEnd: endRep,
      repGained,
      repPerSec,
      peakMoney: cur.peakMoney ?? endMoney,
      peakIncomePerSec: cur.peakIncome,
      peakRepPerSec: cur.peakRepRate,
      augsBefore: cur.augsInstalled,
      augsAfter: s.augsInstalled,
      bought: got.bought,
      nfg: got.nfg,
      value,
      valueRate,
      reason: vals.reason ?? got.reason,
      rates: vals.rates,
      vsPrev,
    });
    st.nodeInstalls = (st.nodeInstalls ?? 0) + 1;
    st.nodeEarned = addEarned(st.nodeEarned ?? {}, earned);
    st.nodeSpent = (st.nodeSpent ?? 0) + spent + installSpent;
    st.nodeHackExp = (st.nodeHackExp ?? 0) + hackExpGained;
    st.nodePeakIncome = Math.max(st.nodePeakIncome ?? 0, cur.peakIncome);
    st.nodePeakRep = Math.max(st.nodePeakRep ?? 0, cur.peakRepRate);
    st.nodePeakMoney = Math.max(st.nodePeakMoney ?? 0, cur.peakMoney ?? endMoney);
    if (nodeReset) {
      const dctx = readJson<{ t?: number; route?: string; node?: number }>(ns, DATA.destroyContext, {});
      const nodeDuration = s.lastNodeReset - st.lastNodeReset;
      appendJsonl(ns, DATA.nodes, {
        t: s.t,
        node: dctx.node ?? null,
        // the level just cleared: for BN12 every clear is harder than the last
        nodeLevel: cur.nodeLevel,
        builds: st.nodeBuilds,
        durationMs: nodeDuration,
        gapMs: st.nodeGapMs ?? 0,
        trackedMs: Math.max(0, nodeDuration - (st.nodeGapMs ?? 0)),
        installs: st.nodeInstalls,
        avgRunMs: st.nodeInstalls > 0 ? nodeDuration / st.nodeInstalls : null,
        route: (dctx.t ?? 0) >= st.lastNodeReset ? dctx.route : null,
        milestones: st.milestones ?? {},
        earned: st.nodeEarned,
        earnedTotal: earnedTotalOf(st.nodeEarned),
        spent: st.nodeSpent,
        hackExpGained: st.nodeHackExp,
        peakIncomePerSec: st.nodePeakIncome,
        peakRepPerSec: st.nodePeakRep,
        peakMoney: st.nodePeakMoney,
      });
      st.nodeInstalls = 0;
      st.nodeGapMs = 0;
      st.nodeBuilds = build ? [build] : [];
      st.milestones = {};
      st.nodeEarned = {};
      st.nodeSpent = 0;
      st.nodeHackExp = 0;
      st.nodePeakIncome = 0;
      st.nodePeakRep = 0;
      st.nodePeakMoney = 0;
    }
    event("reset", nodeReset ? "BitNode reset detected" : `augments installed (+${s.augsInstalled - cur.augsInstalled})`);
    st.installs++;
    st.lastAugReset = s.lastAugReset;
    st.lastNodeReset = s.lastNodeReset;
    st.cur = freshRun(s);
    if (build) st.cur.builds = [build];
  } else {
    // mid-run peak/end values; the pre-install tick is what the next run summary uses
    st.cur.peakIncome = Math.max(st.cur.peakIncome, r.income);
    st.cur.peakRepRate = Math.max(st.cur.peakRepRate, r.repTotal);
    st.cur.hackLevel = s.hackLevel;
    st.cur.lastMoney = s.money;
    st.cur.peakMoney = Math.max(st.cur.peakMoney ?? s.money, s.money);
    st.cur.lastHackExp = s.hackExp;
    st.cur.lastRepTotal = sumNumbers(s.rep);
    st.cur.lastEarned = { ...s.earned };
  }
  // what the money bought: RAM by kind and hacknet purchases (status files, if fresh)
  const now = st.cur;
  const hk = readJson<{ t?: number; ramBy?: RamBy }>(ns, DATA.hackStatus, {});
  if (hk.ramBy && hk.t && s.t - hk.t < 60_000 && hk.t >= now.start) {
    now.startRam ??= hk.ramBy;
    now.lastRam = hk.ramBy;
  }
  const hn = readJson<{ t?: number; spent?: Record<string, number>; bought?: Record<string, number>; production?: number }>(ns, DATA.hacknet, {});
  if (hn.t && s.t - hn.t < 60_000 && hn.t >= now.start) {
    now.hashes = tally(now.hashes, hn.spent);
    now.hashProduction = tally(now.hashProduction, hn.bought);
    now.lastHashRate = hn.production;
  }
  writeJson(ns, STATE_FILE, st);
}

function draw(
  ns: NS,
  s: Snapshot,
  m: Metrics,
  hackInfo: HackInfo,
  plan: Plan | null,
  recent: string[],
) {
  const r = m.long.spanMs >= 120_000 ? m.long : m.short;
  const L: string[] = [];
  L.push(`BN${s.node}  ·  ${dur(m.sinceInstall)} since install  ·  hack ${s.hackLevel}  ·  ports ${portOpenerCount(ns)}/5`);
  L.push(`money ${money(s.money)}   income ${money(m.short.income)}/s (1m)  ${money(m.long.income)}/s (10m)`);
  const top = Object.entries(r.bySource)
    .filter(([, v]) => Math.abs(v) > 0.5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k} ${money(v)}/s`);
  if (top.length) L.push(`  ${top.join("  ·  ")}`);
  L.push(`hacking: pool ${ram(hackInfo.poolTotal ?? 0)}  expected ${money(hackInfo.expectedPerSec ?? 0)}/s   home ${ram(s.homeRam)} / ${s.homeCores}c`);

  L.push("");
  L.push(`rep/s total ${num(r.repTotal)}   work: ${describeWork(s)}`);
  const facs = Object.entries(s.rep).sort((a, b) => (r.rep[b[0]] ?? 0) - (r.rep[a[0]] ?? 0) || b[1] - a[1]);
  for (const [f, rep] of facs.slice(0, 6))
    L.push(`  ${pad(f, 24)} ${pad(num(rep), 9, true)} rep  ${pad(num(r.rep[f] ?? 0), 8, true)}/s  favor ${num(s.favor[f] ?? 0, 0)}`);
  if (s.invites.length) L.push(`  invites: ${s.invites.join(", ")}`);

  if (graftTop)
    L.push(
      `grafting: best ${graftTop.aug} net ${graftTop.net.toFixed(2)} in ${graftTop.hours.toFixed(1)}h (${graftTop.netPerHour.toFixed(3)}/h), Entropy → ${graftTop.entropyAfter}${graftTop.factionEtaH === null ? ", no faction offers it" : ""}`,
    );
  const gs = readJson<Partial<GraftState>>(ns, DATA.graftingState, {});
  if (graftingRunning(ns, s) && (gs.status === "starting" || gs.status === "grafting") && gs.aug)
    L.push(`  ${gs.aug} grafting since ${dur(Date.now() - (gs.started ?? gs.t ?? Date.now()))}`);
  const co = readJson<Partial<CorpStatus>>(ns, DATA.corp, {});
  if (co.t && Date.now() - co.t < 300_000)
    L.push(
      co.exists
        ? `corp: funds ${money(co.funds ?? 0)}  ${money((co.revenue ?? 0) - (co.expenses ?? 0))}/s profit  ${co.cities ?? 0} cities, ${co.employees ?? 0} staff  ${co.public ? `public, dividends ${((co.dividendRate ?? 0) * 100).toFixed(0)}%` : `round ${co.round} offer ${money(co.offer ?? 0)}`}${co.note ? `  (${co.note})` : ""}`
        : `corp: ${co.note}`,
    );
  const hn = readJson<Partial<HacknetStatus>>(ns, DATA.hacknet, {});
  if (hn.t && Date.now() - hn.t < 120_000)
    L.push(
      `hacknet: ${hn.servers ?? 0} servers  ${num(hn.production ?? 0)} h/s  ${num(hn.hashes ?? 0)}/${num(hn.capacity ?? 0)} hashes  ${hn.decision || hn.note || ""}`,
    );
  const st = readJson<Partial<StocksStatus>>(ns, DATA.stocks, {});
  if (st.t && Date.now() - st.t < 120_000)
    L.push(
      st.mode && st.mode !== "waiting"
        ? `stocks (${st.mode}): ${money(st.value ?? 0)} in ${st.positions ?? 0} positions  realized ${money(st.realized ?? 0)}  ${st.trades ?? 0} trades${st.note ? `  (${st.note})` : ""}`
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
    if (plan.shareAll && plan.work)
      L.push(`  → money target met: reserve ${money(plan.augReserve)}, all surplus RAM on ${plan.work.faction} rep`);
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
    case "GRAFTING":
      return `grafting ${w.augmentation}`;
    default:
      return w.type.toLowerCase();
  }
}
