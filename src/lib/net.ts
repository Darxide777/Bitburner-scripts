// Network discovery and rooting. Uses only cheap functions (scan, nuke, the
// port openers, fileExists, hasRootAccess, getServerNumPortsRequired).
import type { NS } from "@ns";

/** Every host reachable from home (BFS), home first. */
export function allHosts(ns: NS): string[] {
  const seen = new Set<string>(["home"]);
  const queue = ["home"];
  while (queue.length) {
    const h = queue.shift()!;
    for (const n of ns.scan(h)) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return [...seen];
}

/** Path of hostnames from home to `target` (exclusive of home), or null. */
export function pathTo(ns: NS, target: string): string[] | null {
  const parent = new Map<string, string>();
  const queue = ["home"];
  const seen = new Set(queue);
  while (queue.length) {
    const h = queue.shift()!;
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
  for (const h of hosts) {
    if (ns.hasRootAccess(h)) continue;
    if (ns.getServerNumPortsRequired(h) > tools.length) continue;
    for (const open of tools) open(h);
    try {
      if (ns.nuke(h)) fresh.push(h);
    } catch {
      /* not enough ports after all */
    }
  }
  return fresh;
}

export function portOpenerCount(ns: NS): number {
  return openers(ns).length;
}
