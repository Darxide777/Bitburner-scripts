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
import { DATA, GANG_KARMA, SCRIPTS } from "./lib/paths.js";
import { runTask } from "./lib/task.js";
import type { Snapshot } from "./lib/types.js";
import type { HackConfig } from "./hack/manager.js";

interface DaemonConfig {
  tickMs: number;
  /** Fraction of current money the economy module may spend per run. */
  infraSpend: number;
  economyEveryMs: number;
}
const DEFAULTS: DaemonConfig = { tickMs: 2000, infraSpend: 0.5, economyEveryMs: 10_000 };

interface DaemonState {
  lastAugReset: number;
  lastNodeReset: number;
  installs: number;
  /** Peak values of the run in progress, summarized into data/runs.txt on reset. */
  run: { start: number; peakIncome: number; peakRepRate: number; hackLevel: number; augsInstalled: number };
}

const STATE_FILE = "data/daemon-state.txt";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  ns.ui.openTail();
  ns.ui.setTailTitle("Bitburner automation");

  const tracker = new MetricsTracker();
  const recent: string[] = [];
  let lastEconomy = 0;
  let lastMetricsLine = 0;
  let lastError = "";

  const event = (kind: string, msg: string, data?: unknown) => {
    appendJsonl(ns, DATA.events, { t: Date.now(), kind, msg, data }, 3000);
    recent.unshift(`${new Date().toLocaleTimeString()} ${msg}`);
    recent.length = Math.min(recent.length, 8);
  };

  event("start", "daemon started");

  while (true) {
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

    // ---- hacking manager ----
    const reserve = homeReserve(ns);
    const hackCfg: Partial<HackConfig> = {
      homeReserve: reserve,
      // lend spare RAM to factions while we are working for one
      share: s?.work?.type === "FACTION" ? 1 : 0,
    };
    writeJson(ns, DATA.hackConfig, hackCfg);
    if (!ns.isRunning(SCRIPTS.hackManager, "home")) {
      const pid = ns.exec(SCRIPTS.hackManager, "home");
      if (pid) event("hack", "started hacking manager");
    }

    // ---- economy ----
    if (s && Date.now() - lastEconomy > cfg.economyEveryMs) {
      lastEconomy = Date.now();
      const r = await runTask<string[]>(ns, "tasks/economy.js", [s.money * cfg.infraSpend]);
      if (r.ok) for (const a of r.value ?? []) event("buy", a);
      else if (r.reason !== "ram") event("error", `economy failed: ${r.error}`);
    }

    // ---- persistence ----
    if (s) {
      const hack = readJson<{ expectedPerSec?: number; poolTotal?: number }>(ns, DATA.hack, {});
      writeJson(ns, DATA.status, { snapshot: s, metrics: m, hack });
      if (Date.now() - lastMetricsLine > 60_000) {
        lastMetricsLine = Date.now();
        appendJsonl(ns, DATA.metrics, metricsLine(s, m, hack), 10_000);
      }
      draw(ns, s, m, hack, recent);
    }

    await ns.sleep(cfg.tickMs);
  }
}

/** RAM to keep free on home for tasks: the biggest task + headroom. */
function homeReserve(ns: NS): number {
  const tasks = ns.ls("home", "tasks/").filter((f) => f.endsWith(".js"));
  const biggest = Math.max(0, ...tasks.map((t) => ns.getScriptRam(t, "home")));
  const home = ns.getServerMaxRam("home");
  // never reserve more than half of home
  return Math.min(home / 2, biggest + 8);
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
  const st = readJson<DaemonState | null>(ns, STATE_FILE, null);
  const m = tracker.metrics();
  const r = m.long.window >= 120_000 ? m.long : m.short;
  if (!st) {
    writeJson(ns, STATE_FILE, {
      lastAugReset: s.lastAugReset,
      lastNodeReset: s.lastNodeReset,
      installs: 0,
      run: { start: s.lastAugReset, peakIncome: 0, peakRepRate: 0, hackLevel: s.hackLevel, augsInstalled: s.augsInstalled },
    } satisfies DaemonState);
    return;
  }
  if (st.lastAugReset !== s.lastAugReset) {
    const nodeReset = st.lastNodeReset !== s.lastNodeReset;
    appendJsonl(ns, DATA.runs, {
      t: s.t,
      kind: nodeReset ? "node" : "install",
      node: s.node,
      durationMs: s.lastAugReset - st.run.start,
      peakIncomePerSec: st.run.peakIncome,
      peakRepPerSec: st.run.peakRepRate,
      endHackLevel: st.run.hackLevel,
      augsBefore: st.run.augsInstalled,
      augsAfter: s.augsInstalled,
    });
    event("reset", nodeReset ? "BitNode reset detected" : `augments installed (+${s.augsInstalled - st.run.augsInstalled})`);
    st.installs++;
    st.lastAugReset = s.lastAugReset;
    st.lastNodeReset = s.lastNodeReset;
    st.run = { start: s.lastAugReset, peakIncome: 0, peakRepRate: 0, hackLevel: s.hackLevel, augsInstalled: s.augsInstalled };
  }
  st.run.peakIncome = Math.max(st.run.peakIncome, r.income);
  st.run.peakRepRate = Math.max(st.run.peakRepRate, r.repTotal);
  st.run.hackLevel = s.hackLevel;
  writeJson(ns, STATE_FILE, st);
}

function draw(
  ns: NS,
  s: Snapshot,
  m: Metrics,
  hack: { expectedPerSec?: number; poolTotal?: number },
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

  L.push("");
  if (s.gang) {
    L.push(`gang ${s.gang.faction}: ${s.gang.members} members  respect ${num(s.gang.respect)}  territory ${(s.gang.territory * 100).toFixed(1)}%  ${money(s.gang.moneyRate * 5)}/s`);
  } else {
    L.push(`karma ${num(s.karma)} / ${num(GANG_KARMA)}  (${num(r.karma)}/s)  →  time to gang ${dur(m.timeToGang)}`);
  }
  L.push(`sleeves ${s.sleeves}   kills ${s.kills}`);

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
