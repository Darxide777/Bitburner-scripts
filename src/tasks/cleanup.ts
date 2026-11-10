// Removes stale scratch files left by lib/call.ts proxies. Each call rewrites its own
// tmp/call/<fn>.<caller>.in.txt / .out.txt pair, so anything untouched for a while is
// from an old caller/build and only inflates the save. The generated proxy .js files
// are kept: they are tiny and reused.
import type { NS } from "@ns";

const DIR = "tmp/call/";
const MAX_AGE_MS = 10 * 60_000;

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const now = Date.now();
  let removed = 0;
  for (const file of ns.ls("home", DIR)) {
    if (!file.endsWith(".in.txt") && !file.endsWith(".out.txt")) continue;
    let mtime = 0;
    try {
      mtime = ns.getFileMetadata(file).mtime;
    } catch {
      continue; // vanished or unreadable: not ours to delete
    }
    if (now - mtime < MAX_AGE_MS) continue;
    try {
      if (ns.rm(file, "home")) removed++;
    } catch {
      /* already gone */
    }
  }
  if (removed) ns.print(`removed ${removed} stale tmp/call file(s)`);
}
