// Network discovery and rooting. Uses only cheap functions (scan, nuke, the
// port openers, fileExists, hasRootAccess, getServerNumPortsRequired).
import type { NS } from "@ns";
import { WORLD_DAEMON } from "./paths.js";

/**
 * Hacknet servers never run scripts: any RAM in use lowers their hash production, and
 * hashes sell for money anyway. Every place that picks hosts for scripts uses this.
 */
export const isHacknet = (host: string): boolean => host.startsWith("hacknet-");

/** Every host reachable from home (BFS), home first. */
export function allHosts(ns: NS): string[] {
  const seen = new Set<string>(["home"]);
  const queue = ["home"];
  for (let i = 0; i < queue.length; i++) {
    for (const n of ns.scan(queue[i])) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return queue;
}

/** Path of hostnames from home to `target` (exclusive of home), or null. */
export function pathTo(ns: NS, target: string): string[] | null {
  const parent = new Map<string, string>();
  const queue = ["home"];
  const seen = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    const h = queue[i];
    if (h === target) break;
    for (const n of ns.scan(h)) {
      if (!seen.has(n)) {
        seen.add(n);
        parent.set(n, h);
        queue.push(n);
      }
    }
  }
  if (!seen.has(target)) return null;
  const path: string[] = [];
  for (let h = target; h !== "home"; h = parent.get(h)!) path.unshift(h);
  return path;
}

function openers(ns: NS): ((h: string) => boolean)[] {
  const list: [string, (h: string) => boolean][] = [
    ["BruteSSH.exe", (h) => ns.brutessh(h)],
    ["FTPCrack.exe", (h) => ns.ftpcrack(h)],
    ["relaySMTP.exe", (h) => ns.relaysmtp(h)],
    ["HTTPWorm.exe", (h) => ns.httpworm(h)],
    ["SQLInject.exe", (h) => ns.sqlinject(h)],
  ];
  return list.filter(([file]) => ns.fileExists(file, "home")).map(([, fn]) => fn);
}

/** Try to root every host. Returns hosts that were newly rooted this call. */
export function rootAll(ns: NS, hosts = allHosts(ns)): string[] {
  const tools = openers(ns);
  const fresh: string[] = [];
  // port openers and nuke work by hostname, so w0r1d_d43m0n is tried even when no scan
  // reaches it; it throws "invalid hostname" while it doesn't exist yet
  const all = hosts.includes(WORLD_DAEMON) ? hosts : [...hosts, WORLD_DAEMON];
  for (const h of all) {
    try {
      if (ns.hasRootAccess(h)) continue;
      if (ns.getServerNumPortsRequired(h) > tools.length) continue;
      for (const open of tools) open(h);
      if (ns.nuke(h)) fresh.push(h);
    } catch {
      /* not enough ports after all, or no such host */
    }
  }
  return fresh;
}

export function portOpenerCount(ns: NS): number {
  return openers(ns).length;
}
