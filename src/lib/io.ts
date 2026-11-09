// File-backed JSON state. ns.read / ns.write cost 0 GB, which makes files the
// cheapest way for scripts to share state. Everything under data/ is pulled out
// of the game by tools/sync.mjs into ./logs/ for offline analysis.
import type { NS } from "@ns";

/** JSON replacer that survives the Maps the game returns (e.g. ResetInfo.ownedAugs). */
export function replacer(_k: string, v: unknown): unknown {
  if (v instanceof Map) return Object.fromEntries(v);
  if (v instanceof Set) return [...v];
  if (typeof v === "bigint") return v.toString(); // e.g. Square Root contracts
  return v;
}

export function readJson<T>(ns: NS, file: string, fallback: T): T {
  const raw = ns.read(file);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(ns: NS, file: string, value: unknown): void {
  ns.write(file, JSON.stringify(value, replacer), "w");
}

/**
 * Append one JSON line to a log file, keeping at most `maxLines` lines.
 * Trimming rewrites the file only occasionally (when it exceeds maxLines by 10%).
 */
export function appendJsonl(ns: NS, file: string, value: unknown, maxLines = 5000): void {
  ns.write(file, JSON.stringify(value, replacer) + "\n", "a");
  const raw = ns.read(file);
  // cheap line-count estimate without splitting every time
  let lines = 0;
  for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) lines++;
  if (lines > maxLines * 1.1) {
    const kept = raw.split("\n").filter(Boolean).slice(-maxLines);
    ns.write(file, kept.join("\n") + "\n", "w");
  }
}

/**
 * Append one plain-text line (trace files), keeping at most `maxLines`. In-game files live in
 * the save; the sync tool archives every line locally (logs/archive/), so these stay small.
 */
export function appendLine(ns: NS, file: string, line: string, maxLines = 500): void {
  ns.write(file, line.endsWith("\n") ? line : line + "\n", "a");
  const raw = ns.read(file);
  let lines = 0;
  for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) lines++;
  if (lines > maxLines * 1.1) ns.write(file, raw.split("\n").filter(Boolean).slice(-maxLines).join("\n") + "\n", "w");
}
