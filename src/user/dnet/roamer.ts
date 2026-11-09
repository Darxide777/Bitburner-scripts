// Bitburner single-player game module: propagates the automation through the game's
// fictional darknet using `ns.dnet` and game files only.
import type { DarknetServerDetails, NS } from "@ns";
import {
  MODEL,
  authenticateRetry,
  loadStore,
  mergeLocalSnapshots,
  paths,
  pushSnapshotTo,
  pushSnapshotToHome,
  recordReward,
  saveStore,
  storeHash,
  type DnetPaths,
  type Store,
} from "./lib.js";
import { needsFeedback, solve } from "./solvers.js";

const COOLDOWN_MS = 45_000;
const LAB_RETRY_MS = 60_000;
const LAB_COOLDOWN_MS = 10 * 60_000;
const STORE_PUSH_EVERY = 3;

function log(ns: NS, message: string): void {
  ns.print("[" + ns.getHostname() + "] " + message);
}

function lootCaches(ns: NS): void {
  let files: string[] = [];
  try {
    files = ns.ls(ns.getHostname(), ".cache");
  } catch {
    return;
  }

  for (const file of files) {
    if (typeof file !== "string") continue;
    try {
      const result = ns.dnet.openCache(file, true);
      if (result && result.success) {
        recordReward(ns, ns.getHostname(), file, result);
        log(ns, "opened cache " + file + ": " + (result.message || "reward"));
      } else {
        log(ns, "cache failed " + file + ": " + (result && result.message ? result.message : "unknown"));
      }
    } catch (e) {
      log(ns, "cache error " + file + ": " + String(e));
    }
  }
}

async function ensureSession(
  ns: NS,
  host: string,
  details: DarknetServerDetails,
  store: Store,
  cooldown: Map<string, number>,
  charisma: number,
): Promise<boolean> {
  if (details.hasSession) return true;
  const now = Date.now();
  const blockedUntil = cooldown.get(host) || 0;
  if (blockedUntil > now) return false;

  const password = store[host];
  if (typeof password === "string") {
    const result = await authenticateRetry(ns, host, password);
    if (result.success) return true;
    const code = result.result ? result.result.code : null;
    if (code === null || code === 351 || code === 408 || code === 503) return false;
    delete store[host];
    saveStore(ns, store);
  }

  if (needsFeedback(details) && charisma < details.requiredCharismaSkill) {
    cooldown.set(host, now + COOLDOWN_MS * 4);
    log(ns, "skip " + host + ": charisma " + details.requiredCharismaSkill + " required");
    return false;
  }

  const solved = await solve(ns, host, details);
  if (!solved.password) {
    cooldown.set(host, now + COOLDOWN_MS);
    log(ns, "failed " + host + " [" + details.modelId + "]: " + solved.reason);
    return false;
  }

  const result = await authenticateRetry(ns, host, solved.password);
  if (!result.success) {
    cooldown.set(host, now + COOLDOWN_MS);
    log(ns, "auth failed " + host + " after solve");
    return false;
  }

  store[host] = solved.password;
  saveStore(ns, store);
  log(ns, "cracked " + host + " [" + details.modelId + "] = " + solved.password);
  return true;
}

async function ensureChild(ns: NS, host: string, p: DnetPaths, store: Store): Promise<boolean> {
  try {
    try {
      ns.scp(p.charisma, host);
    } catch {}
    try {
      if (!ns.fileExists(p.lab, host)) ns.scp(p.lab, host);
    } catch {}
    const running = ns.isRunning(p.roamer, host, "auto") || ns.isRunning(p.roamer, host);
    if (running) return true;

    const needed = ns.getScriptRam(p.roamer);
    const maximum = ns.getServerMaxRam(host);
    if (maximum < needed) {
      log(ns, "no room for child on " + host + " (" + maximum + "GB max)");
      return false;
    }
    const free = maximum - ns.getServerUsedRam(host);
    if (free < needed) return false;

    try {
      if (!ns.scp([p.lib, p.solvers, p.roamer], host)) return false;
    } catch {
      return false;
    }
    pushSnapshotTo(ns, store, host);

    const pid = ns.exec(p.roamer, host, 1, "auto");
    if (pid > 0) log(ns, "spawned roamer on " + host);
    return pid > 0;
  } catch {
    return false;
  }
}

async function startLab(
  ns: NS,
  me: string,
  p: DnetPaths,
  host: string,
  details: DarknetServerDetails,
  charisma: number,
  cooldown: Map<string, number>,
): Promise<boolean> {
  const now = Date.now();
  if (charisma < details.requiredCharismaSkill) {
    cooldown.set(host, now + LAB_COOLDOWN_MS);
    log(ns, "skip labyrinth " + host + ": charisma " + details.requiredCharismaSkill + " required");
    return false;
  }
  if (ns.isRunning(p.lab, me)) return true;

  const blockedUntil = cooldown.get(host) || 0;
  if (blockedUntil > now) return false;

  let report: any = null;
  try {
    report = await ns.dnet.labreport();
  } catch {}
  if (!report || report.success !== true) {
    cooldown.set(host, now + LAB_RETRY_MS);
    return false;
  }

  let ram = 0;
  try {
    ram = ns.getScriptRam(p.lab, me);
  } catch {}
  if (!ram || ram <= 0) {
    log(ns, "labyrinth solver missing or has zero RAM: " + p.lab);
    cooldown.set(host, now + LAB_COOLDOWN_MS);
    return false;
  }

  const free = Math.max(0, ns.getServerMaxRam(me) - ns.getServerUsedRam(me));
  let threads = Math.min(64, Math.max(1, Math.floor(free / ram)));
  for (; threads >= 1; threads--) {
    let pid = 0;
    try {
      pid = ns.exec(p.lab, me, threads, host, details.requiredCharismaSkill);
    } catch {}
    if (pid > 0) {
      cooldown.set(host, now + LAB_COOLDOWN_MS);
      log(ns, "started labyrinth solver for " + host + " threads=" + threads);
      return true;
    }
  }

  log(ns, "not enough RAM for labyrinth solver on " + me);
  cooldown.set(host, now + LAB_RETRY_MS);
  return false;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const me = ns.getHostname();
  const p = paths(ns);
  const store = loadStore(ns);
  const cooldown = new Map<string, number>();
  if (mergeLocalSnapshots(ns, store)) saveStore(ns, store);

  let lastPushHash: number | null = null;
  let loop = 0;

  while (true) {
    loop += 1;
    if (mergeLocalSnapshots(ns, store)) saveStore(ns, store);
    lootCaches(ns);

    let charisma = Infinity;
    try {
      const raw = ns.read(p.charisma).trim();
      if (raw) {
        const value = Number(raw);
        if (Number.isFinite(value)) charisma = value;
      }
    } catch {}

    let neighbors: string[] = [];
    try {
      neighbors = ns.dnet.probe();
    } catch (e) {
      log(ns, "probe failed: " + String(e));
      await ns.sleep(10_000);
      continue;
    }

    const authenticated: string[] = [];
    let labHost: string | null = null;
    let labDetails: (DarknetServerDetails & { isOnline: boolean }) | null = null;

    for (const host of neighbors) {
      if (typeof host !== "string") continue;
      let details: (DarknetServerDetails & { isOnline: boolean }) | null = null;
      try {
        details = ns.dnet.getServerDetails(host);
      } catch {
        continue;
      }
      if (!details || details.isOnline === false) continue;
      if (!details.isConnectedToCurrentServer) continue;
      if (details.modelId === MODEL.labyrinth) {
        if (!labHost) {
          labHost = host;
          labDetails = details;
        }
        continue;
      }

      let ready = false;
      try {
        ready = await ensureSession(ns, host, details, store, cooldown, charisma);
      } catch (e) {
        log(ns, "error on " + host + ": " + String(e));
        cooldown.set(host, Date.now() + COOLDOWN_MS);
        ready = false;
      }
      if (!ready) continue;
      authenticated.push(host);
      await ensureChild(ns, host, p, store);
    }

    if (labHost && labDetails) {
      try {
        await startLab(ns, me, p, labHost, labDetails, charisma, cooldown);
      } catch (e) {
        log(ns, "labyrinth error on " + labHost + ": " + String(e));
        cooldown.set(labHost, Date.now() + LAB_RETRY_MS);
      }
    }

    const hash = storeHash(store);
    const changed = hash !== lastPushHash;
    for (const host of authenticated) {
      try {
        ns.scp(p.charisma, host);
      } catch {}
      if (changed && (ns.isRunning(p.roamer, host, "auto") || ns.isRunning(p.roamer, host))) {
        pushSnapshotTo(ns, store, host);
      }
    }

    if (changed) {
      if (me !== "home") pushSnapshotToHome(ns, store);
      lastPushHash = hash;
    } else if (loop % STORE_PUSH_EVERY === 0 && me !== "home") {
      pushSnapshotToHome(ns, store);
    }

    saveStore(ns, store);

    try {
      await ns.dnet.nextMutation();
    } catch {
      await ns.sleep(20_000);
    }
    await ns.sleep(2000);
  }
}
