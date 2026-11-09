// Append-only local history for the in-game logs (used by tools/sync.mjs).
//
// The in-game files are capped small because they live in the save file; every pull hands
// their current content here, and only lines newer than what the archive already holds are
// appended to <dir>/<name>.jsonl. A line's time is its JSON `t`, or a leading ISO timestamp
// (trace files); lines sharing the newest time are compared by content (events often share
// a millisecond).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A line's time: JSON `t`, else a leading ISO timestamp; null if neither. */
export function lineKey(line) {
  if (line.startsWith("{")) {
    try {
      const t = JSON.parse(line).t;
      return typeof t === "number" ? t : null;
    } catch {
      return null;
    }
  }
  const iso = Date.parse(line.slice(0, 24));
  return Number.isFinite(iso) ? iso : null;
}

/** Returns archive(name, content) → number of lines appended. */
export function makeArchive(dir) {
  /** per file: the newest key archived and the lines carrying exactly that key */
  const tails = new Map();
  const tailOf = (file) => {
    if (tails.has(file)) return tails.get(file);
    const tail = { key: -Infinity, lines: new Set() };
    if (existsSync(file)) {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        const k = lineKey(lines[i]);
        if (k === null) continue;
        if (tail.key === -Infinity) tail.key = k;
        if (k !== tail.key) break;
        tail.lines.add(lines[i]);
      }
    }
    tails.set(file, tail);
    return tail;
  };
  return (name, content) => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.jsonl`);
    const tail = tailOf(file);
    const fresh = [];
    for (const line of content.split("\n").filter(Boolean)) {
      const k = lineKey(line);
      if (k === null || k < tail.key || (k === tail.key && tail.lines.has(line))) continue;
      if (k > tail.key) [tail.key, tail.lines] = [k, new Set()];
      tail.lines.add(line);
      fresh.push(line);
    }
    if (fresh.length) appendFileSync(file, fresh.join("\n") + "\n");
    return fresh.length;
  };
}
