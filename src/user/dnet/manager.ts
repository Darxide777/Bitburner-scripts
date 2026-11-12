// Bitburner user module entry point. It only coordinates the game's `ns.dnet` API and
// in-game files; no real network, host, or credential is involved.
import type { NS } from "@ns";
import type { DaemonContext } from "../../daemon.js";
import { appendLines, readJson, writeJson, appendStatus } from "../../lib/io.js";
import { DATA } from "../../lib/paths.js";
import {
  REWARD_PORT,
  authenticateRetry,
  loadStore,
  mergeLocalSnapshots,
  paths,
  pushSnapshotTo,
  readLabStatus,
  saveStore,
  storeHash,
  type DnetPaths,
  type Store,
} from "./lib.js";

const SETUP_REFRESH_MS = 5 * 60_000;
const START_RETRY_MS = 30_000;
const LOOP_MS = 15_000;
/** Reward lines kept in the in-save ledger; older ones are trimmed (this file isn't archived). */
const MAX_REWARDS = 2000;

function log(ns: NS, message: string): void {
  ns.print("[dnet-manager] " + message);
}

function drainRewards(ns: NS, p: DnetPaths): string[] {
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) {
    const value: unknown = ns.readPort(REWARD_PORT);
    if (value === "NULL PORT DATA") break;
    lines.push(typeof value === "string" ? value : JSON.stringify(value));
  }
  if (!lines.length) return lines;
  try {
    appendLines(ns, p.rewards, lines, MAX_REWARDS);
  } catch {}
  for (const line of lines) log(ns, "reward " + line);
  return lines;
}

function updateReserve(ns: NS, store: Store): void {
  const current = readJson<Record<string, unknown>>(ns, DATA.userReserve, {});
  const hosts = new Set<string>();
  if (Array.isArray(current.hosts)) {
    for (const host of current.hosts) if (typeof host === "string") hosts.add(host);
  }
  hosts.add("darkweb");
  for (const host of Object.keys(store)) hosts.add(host);
  writeJson(ns, DATA.userReserve, { ...current, hosts: [...hosts] });
}

function killDarkwebRoamers(ns: NS, p: DnetPaths): number {
  let killed = 0;
  try {
    for (const proc of ns.ps("darkweb")) {
      const isRoamer = proc.filename.endsWith("dnet-roamer.js") || proc.filename.endsWith("roamer.js");
      if (!isRoamer) continue;
      // preserve the current auto roamer (this manager's own process)
      if (proc.filename === p.roamer && proc.args[0] === "auto") continue;
      try {
        if (ns.kill(proc.filename, "darkweb", ...proc.args)) killed++;
      } catch {}
    }
  } catch {}
  return killed;
}

function killStaleRoamers(ns: NS, p: DnetPaths): number {
  let killed = 0;
  try {
    for (const proc of ns.ps("darkweb")) {
      const staleName = proc.filename.endsWith("dnet-roamer.js") || proc.filename.endsWith("roamer.js");
      if (!staleName) continue;
      if (proc.filename === p.roamer && proc.args[0] === "auto") continue;
      try {
        if (ns.kill(proc.filename, "darkweb", ...proc.args)) killed++;
      } catch {}
    }
  } catch {}
  return killed;
}

function tryExec(ns: NS, p: DnetPaths): boolean {
  try {
    const needed = ns.getScriptRam(p.roamer);
    const maximum = ns.getServerMaxRam("darkweb");
    let free = maximum - ns.getServerUsedRam("darkweb");
    if (needed <= 0) {
      log(ns, "roamer RAM is 0; check built files on home");
      return false;
    }
    if (maximum < needed) {
      log(ns, "roamer needs " + needed + "GB but darkweb max is " + maximum + "GB");
      return false;
    }
    if (free < needed) {
      const killed = killStaleRoamers(ns, p);
      if (killed > 0) {
        log(ns, "killed " + killed + " stale darkweb roamer(s)");
        free = maximum - ns.getServerUsedRam("darkweb");
      }
    }
    if (free < needed) {
      log(ns, "not enough darkweb RAM: need=" + needed + " free=" + free);
      return false;
    }
    const pid = ns.exec(p.roamer, "darkweb", 1, "auto");
    log(ns, "darkweb exec pid=" + pid);
    return pid > 0;
  } catch (e) {
    log(ns, "darkweb exec error: " + String(e));
    return false;
  }
}

async function ensureDarkweb(ns: NS, p: DnetPaths, store: Store): Promise<boolean> {
  let neighbors: string[] = [];
  try {
    neighbors = ns.dnet.probe();
  } catch (e) {
    log(ns, "cannot reach the darknet: " + String(e));
    return false;
  }
  if (!neighbors.includes("darkweb")) {
    log(ns, "darkweb is not directly reachable from home");
    return false;
  }

  let auth = await authenticateRetry(ns, "darkweb", "");
  if (!auth.success && typeof store.darkweb === "string") {
    auth = await authenticateRetry(ns, "darkweb", store.darkweb);
  }
  if (!auth.success) {
    log(ns, "could not authenticate darkweb: " + (auth.result ? auth.result.message : "unknown"));
    return false;
  }

  const killed = killDarkwebRoamers(ns, p);
  if (killed) log(ns, "stopped " + killed + " old darkweb roamer(s)");

  const files = [p.lib, p.solvers, p.roamer];
  const missing = files.filter((file) => !ns.fileExists(file, "home"));
  if (missing.length) {
    log(ns, "missing local files: " + missing.join(", "));
    return false;
  }

  const upload = [...files];
  if (ns.fileExists(p.lab, "home")) upload.push(p.lab);
  try {
    if (!ns.scp(upload, "darkweb")) log(ns, "scp to darkweb returned false");
  } catch (e) {
    log(ns, "scp to darkweb failed: " + String(e));
  }
  try {
    if (ns.fileExists(p.charisma, "home")) ns.scp(p.charisma, "darkweb");
  } catch {}

  const running = ns.isRunning(p.roamer, "darkweb", "auto") || ns.isRunning(p.roamer, "darkweb");
  if (!running) {
    pushSnapshotTo(ns, store, "darkweb");
    log(ns, "starting darkweb roamer");
    return tryExec(ns, p);
  }
  return true;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const p = paths(ns);
  const store = loadStore(ns);
  let lastHash = storeHash(store);
  let lastKeys = new Set(Object.keys(store));
  let lastStartAttempt = 0;
  let lastSetupRefresh = 0;
  let warnedSetupMissing = false;
  let warnedNoDarkweb = false;
  let rewardCount = 0;
  let lastReward = "";
  try {
    const lines = ns.read(p.rewards).split("\n").filter(Boolean);
    rewardCount = lines.length;
    lastReward = lines.length ? lines[lines.length - 1] : "";
  } catch {}

  const killed = killDarkwebRoamers(ns, p);
  if (killed) log(ns, "restarting " + killed + " darkweb roamer(s) on this build");
  if (mergeLocalSnapshots(ns, store)) saveStore(ns, store);
  updateReserve(ns, store);

  while (true) {
    if (mergeLocalSnapshots(ns, store)) saveStore(ns, store);
    updateReserve(ns, store);
    const rewarded = drainRewards(ns, p);
    if (rewarded.length) {
      rewardCount += rewarded.length;
      lastReward = rewarded[rewarded.length - 1];
    }

    const ctx = readJson<Partial<DaemonContext>>(ns, DATA.context, {});
    if (ctx.uiBusy || ctx.installPlanned) {
      await ns.sleep(LOOP_MS);
      continue;
    }

    if (Date.now() - lastSetupRefresh >= SETUP_REFRESH_MS) {
      lastSetupRefresh = Date.now();
      if (!ns.fileExists(p.setup, "home")) {
        if (!warnedSetupMissing) {
          log(ns, "setup skipped: missing " + p.setup);
          warnedSetupMissing = true;
        }
      } else if (!ns.isRunning(p.setup, "home")) {
        try {
          if (ns.exec(p.setup, "home", 1) > 0) log(ns, "checking TOR, DarkscapeNavigator.exe, and charisma");
          else log(ns, "setup failed to launch");
        } catch (e) {
          log(ns, "setup launch error: " + String(e));
        }
      }
    }

    let running = ns.isRunning(p.roamer, "darkweb", "auto") || ns.isRunning(p.roamer, "darkweb");
    if (running) {
      try {
        if (ns.fileExists(p.charisma, "home")) ns.scp(p.charisma, "darkweb");
      } catch {}
      warnedNoDarkweb = false;
    } else if (Date.now() - lastStartAttempt >= START_RETRY_MS) {
      lastStartAttempt = Date.now();
      running = await ensureDarkweb(ns, p, store).catch((e) => {
        log(ns, "darkweb update failed: " + String(e));
        return false;
      });
      if (!running && !warnedNoDarkweb) {
        ns.tprint("Darknet: home cannot reach or start darkweb. TOR + DarkscapeNavigator.exe are required.");
        warnedNoDarkweb = true;
      } else if (running) {
        warnedNoDarkweb = false;
      }
    }

    const hash = storeHash(store);
    if (hash !== lastHash) {
      saveStore(ns, store);
      if (running) pushSnapshotTo(ns, store, "darkweb");
      lastHash = hash;
    }

    const keys = Object.keys(store);
    const fresh = keys.filter((key) => !lastKeys.has(key));
    if (fresh.length) {
      ns.tprint("Darknet passwords known: " + keys.length + " (+" + fresh.length + ")");
      ns.tprint("New: " + fresh.join(", "));
      lastKeys = new Set(keys);
    }

    try {
      appendStatus(ns, DATA.dnet, {
        t: Date.now(),
        known: keys.length,
        charisma: ns.getPlayer().skills.charisma,
        lab: readLabStatus(ns),
        darkwebRoamer: running,
        setupRunning: ns.isRunning(p.setup, "home"),
        rewards: rewardCount,
        lastReward,
      });
    } catch {}
    log(ns, "known=" + keys.length + " darkweb-roamer=" + (running ? "running" : "stopped"));
    await ns.sleep(LOOP_MS);
  }
}
